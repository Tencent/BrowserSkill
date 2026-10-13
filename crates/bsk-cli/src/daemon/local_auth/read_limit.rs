//! Enforce the small pre-authentication limit before tungstenite allocates a
//! payload. Its public async wrapper cannot change WebSocketConfig after open.
use bsk_protocol::local_auth::MAX_MESSAGE_BYTES;
use std::{
    io,
    pin::Pin,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    task::{Context, Poll},
};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

pub struct AuthReadLimit<S> {
    inner: S,
    released: Arc<AtomicBool>,
    parser: HeaderLimit,
}
impl<S> AuthReadLimit<S> {
    pub fn new(inner: S) -> (Self, Arc<AtomicBool>) {
        let released = Arc::new(AtomicBool::new(false));
        (
            Self {
                inner,
                released: released.clone(),
                parser: HeaderLimit::default(),
            },
            released,
        )
    }
}
#[derive(Default)]
struct HeaderLimit {
    http_done: bool,
    http_bytes: usize,
    tail: u32,
    header: Vec<u8>,
    remaining: usize,
    message_bytes: usize,
    finish_message: bool,
}
impl HeaderLimit {
    fn accept(&mut self, bytes: &[u8]) -> io::Result<()> {
        let reject = || {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "local authentication frame limit",
            )
        };
        for &byte in bytes {
            if !self.http_done {
                self.http_bytes += 1;
                if self.http_bytes > 16 * 1024 {
                    return Err(reject());
                }
                self.tail = (self.tail << 8) | u32::from(byte);
                if self.tail == 0x0d0a0d0a {
                    self.http_done = true;
                }
                continue;
            }
            if self.remaining > 0 {
                self.remaining -= 1;
                if self.remaining == 0 && self.finish_message {
                    self.message_bytes = 0;
                }
                continue;
            }
            self.header.push(byte);
            if self.header.len() < 2 {
                continue;
            }
            let code = self.header[1] & 127;
            let length_bytes = match code {
                126 => 2,
                127 => 8,
                _ => 0,
            };
            // Inspect length before passing its last byte to tungstenite.
            if self.header.len() != 2 + length_bytes {
                continue;
            }
            let length = if length_bytes == 0 {
                u64::from(code)
            } else {
                self.header[2..]
                    .iter()
                    .fold(0u64, |n, b| (n << 8) | u64::from(*b))
            };
            if length > MAX_MESSAGE_BYTES as u64 {
                return Err(reject());
            }
            let data = self.header[0] & 8 == 0;
            if data {
                self.message_bytes += length as usize;
                if self.message_bytes > MAX_MESSAGE_BYTES {
                    return Err(reject());
                }
            }
            self.finish_message = data && self.header[0] & 128 != 0;
            self.remaining = length as usize + if self.header[1] & 128 != 0 { 4 } else { 0 };
            if self.remaining == 0 && self.finish_message {
                self.message_bytes = 0;
            }
            self.header.clear();
        }
        Ok(())
    }
}
impl<S: AsyncRead + Unpin> AsyncRead for AuthReadLimit<S> {
    fn poll_read(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        out: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let this = self.get_mut();
        if this.released.load(Ordering::Acquire) {
            return Pin::new(&mut this.inner).poll_read(cx, out);
        }
        let mut bytes = [0u8; 8192];
        let mut buffer = ReadBuf::new(&mut bytes[..out.remaining().min(8192)]);
        match Pin::new(&mut this.inner).poll_read(cx, &mut buffer) {
            Poll::Ready(Ok(())) => {
                if let Err(error) = this.parser.accept(buffer.filled()) {
                    return Poll::Ready(Err(error));
                }
                out.put_slice(buffer.filled());
                Poll::Ready(Ok(()))
            }
            result => result,
        }
    }
}
impl<S: AsyncWrite + Unpin> AsyncWrite for AuthReadLimit<S> {
    fn poll_write(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<io::Result<usize>> {
        Pin::new(&mut self.get_mut().inner).poll_write(cx, bytes)
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_flush(cx)
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.get_mut().inner).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_huge_and_fragmented_messages_before_payload_allocation() {
        let mut parser = HeaderLimit::default();
        parser.accept(b"GET / HTTP/1.1\r\n\r\n").unwrap();
        assert!(
            parser
                .accept(&[0x81, 0xff, 0, 0, 0, 0, 0, 1, 0, 0])
                .is_err()
        );
        let mut parser = HeaderLimit::default();
        parser.accept(b"\r\n\r\n").unwrap();
        parser.accept(&[0x01, 126, 0x0f, 0xff]).unwrap();
        parser.accept(&vec![0; 4095]).unwrap();
        parser.accept(&[0x89, 1, 0]).unwrap(); // interleaved control frame
        assert!(parser.accept(&[0x80, 2]).is_err());
    }
    #[test]
    fn accepts_split_headers_masks_and_successive_messages() {
        let bytes = [
            b"\r\n\r\n".as_slice(),
            &[0x81, 0x82, 1, 2, 3, 4, 1, 2, 0x81, 0],
        ]
        .concat();
        for width in 1..bytes.len() {
            let mut parser = HeaderLimit::default();
            for chunk in bytes.chunks(width) {
                parser.accept(chunk).unwrap();
            }
            assert_eq!(parser.remaining, 0);
            assert_eq!(parser.message_bytes, 0);
        }
    }
}
