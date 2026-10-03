# Freya SQLCipher runtime

This directory contains the pinned Windows x64 native bindings used by the canonical Freya Vault.

- SQLCipher: `v4.19.0` (`c4b275a47932888216bade83aff2bbc73df0ff85`)
- OpenSSL: `openssl-3.5.9` (`45e844fa2a14ec92d146bd8f5778ac130b6625fb`)
- JS API: `better-sqlite3@12.11.1`
- Test runtime binary: `better_sqlite3-node24.node`
- Electron production binary: `better_sqlite3-electron44.node` for Electron `44.5.0`

SHA-256:

- `better_sqlite3-node24.node`: `F9C48C1C210F16111B5ADE188F165C92C0D54C96DC0F8E0D4AF93503D1B53D4C`
- `better_sqlite3-electron44.node`: `90FC9DF998EFB28E16BBD6EC517349CBB885BBFB771442791CA97E2B189C7AFD`

Both binaries were built from the same SQLCipher/OpenSSL source and independently proved to:

- report SQLCipher `4.19.0`;
- create a database whose header is not plaintext `SQLite format 3`;
- reopen with the correct key after process restart;
- reject a wrong key;
- load successfully in their target Node/Electron runtimes.

License notices for better-sqlite3, SQLCipher, SQLite, and OpenSSL are retained in `licenses/`.
