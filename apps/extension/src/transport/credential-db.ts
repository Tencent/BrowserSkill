/** Extension-origin IndexedDB is shared by local and remote credentials. */
export function openCredentialDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("bsk-remote-authorization", 2);
    request.onupgradeneeded = () => {
      for (const name of ["connection", "local", "migration"]) {
        if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
      }
    };
    request.onerror = () => reject(new Error("Credential storage is unavailable"));
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Credential storage is blocked"));
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else {
        request.result.onversionchange = () => request.result.close();
        resolve(request.result);
      }
    };
  });
}
