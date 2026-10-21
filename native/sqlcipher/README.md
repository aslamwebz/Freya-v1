# Freya SQLCipher runtime

This directory contains the pinned Windows x64 native bindings used by the canonical Freya Vault.

- SQLCipher: `v4.19.0` (`c4b275a47932888216bade83aff2bbc73df0ff85`)
- OpenSSL: `openssl-3.5.9` (`45e844fa2a14ec92d146bd8f5778ac130b6625fb`)
- JS API: `better-sqlite3@12.11.1`
- Test runtime binary: `better_sqlite3-node24.node`
- Electron production binary: `better_sqlite3-electron44.node` for Electron `44.5.0`

SHA-256 (of the binaries as committed; the build machine's user name in their debug path was replaced with `XX`, same length, so the code is unchanged):

- `better_sqlite3-node24.node`: `AE179453A0303B7601503C5FF6389775EA8F9F6F7B92F73A964644168DC84868`
- `better_sqlite3-electron44.node`: `7BD62F20FD0CF726A0AAEC7838FB4A987CDEA488803F840A811C8FA9F7458B7D`

Both binaries were built from the same SQLCipher/OpenSSL source and independently proved to:

- report SQLCipher `4.19.0`;
- create a database whose header is not plaintext `SQLite format 3`;
- reopen with the correct key after process restart;
- reject a wrong key;
- load successfully in their target Node/Electron runtimes.

License notices for better-sqlite3, SQLCipher, SQLite, and OpenSSL are retained in `licenses/`.
