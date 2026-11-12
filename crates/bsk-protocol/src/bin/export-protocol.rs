//! Machine-readable input for protocol generation and compatibility checks.

fn main() {
    println!(
        "{}",
        serde_json::to_string_pretty(&bsk_protocol::catalog::export()).unwrap()
    );
}
