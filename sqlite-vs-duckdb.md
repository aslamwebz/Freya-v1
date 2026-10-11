# SQLite vs DuckDB for Embedded Analytics

| Aspect | SQLite | DuckDB |
|---|---|---|
| Storage model | Row-oriented | Columnar |
| Best for | OLTP, small/medium datasets, point queries | OLAP, analytical queries, larger datasets |
| Execution | Interpreted per-row | Vectorized, SIMD, parallel |
| Concurrency | Single writer, multi-reader | Single-process, multi-threaded within query |
| Data scale | Comfortable to low-millions of rows | Designed for tens-of-millions+ |
| Embedded | Yes, in-process, zero-config | Yes, in-process, single `.duckdb` file |
| SQL surface | Core SQL, JSON1, FTS, RTREE | Full T-SQL-like analytical dialect, window functions, Parquet/CSV ingestion |
| Ecosystem | Mature, ubiquitous bindings | Pandas/Arrow/Parquet native |

**Pick SQLite when** your workload is transactional, your datasets fit comfortably in memory-bounded millions, or you need the widest deployment footprint.

**Pick DuckDB when** you're doing aggregations, joins on wide tables, or scanning analytical payloads — especially when Parquet/Arrow are already in play.

**Rule of thumb:** SQLite owns the OLTP edge inside the app; DuckDB owns the analytics. They coexist well — DuckDB can query SQLite files directly.