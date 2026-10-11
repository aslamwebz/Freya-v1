# Vector Databases Architectural Evaluation
## Pinecone vs Qdrant vs Milvus

**Evaluation date:** 2026
**Scope:** Indexing algorithms (HNSW vs IVF), deployment model (self-hosted vs managed), latency and memory consumption
**Method:** Public-source architectural review supplemented with third-party benchmark reports

---

## 1. Executive Summary

All three databases fall into the "modern managed-first" category of vector stores, but they diverge sharply in three areas: (1) whether they expose a self-hosted option, (2) which ANN algorithms they actually run under the hood, and (3) how aggressively they trade memory for query latency.

| Dimension | Pinecone | Qdrant | Milvus |
|---|---|---|---|
| License | Proprietary SaaS | Apache-2.0 (open source) | Apache-2.0 (open source) |
| Self-hostable | **No** | Yes | Yes |
| Native language | Closed (Go services + Rust cores) | Rust | C++ / Go |
| Primary ANN algorithm | Proprietary (Ananas, PQFS, IVF) — **not HNSW** | HNSW (filterable) | HNSW, IVF, DiskANN, GPU indexes |
| Best at | Operational simplicity, serverless scale | Balanced latency / memory / openness | Maximum flexibility, billion-scale |
| Weakness | Vendor lock-in, no self-host, higher TCO at large scale | Less ecosystem tooling than Milvus | Operational complexity |

A common misconception is that Pinecone uses HNSW; Pinecone's own engineering documentation explicitly states it has never used HNSW in any architecture, serverless or pod-based. Its serverless backend runs Ananas, PQFS, and IVF chosen automatically per slab [6]. This finding alone reshapes the "HNSW vs IVF" framing for Pinecone.

---

## 2. Indexing Algorithms: HNSW vs IVF

### 2.1 How HNSW works
Hierarchical Navigable Small World builds a multi-layer proximity graph. Search begins at the top (sparse layer) and greedily descends toward the query, then refines at the bottom (dense layer). It provides **O(log N)** approximate search with very high recall, at the cost of holding the full graph in RAM and longer build times.

### 2.2 How IVF works
Inverted File Index partitions the vector space into `nlist` Voronoi cells (via k-means). At query time, only the `nprobe` closest cells are scanned. IVF trades some recall for lower memory and faster builds. Variants:
- `IVF_FLAT`: full-precision vectors in each cell.
- `IVF_PQ`: Product Quantization compresses each vector to ~8–64 bytes per cell.
- `IVF_SQ8`: scalar quantization to 8-bit.

### 2.3 What each database actually runs

**Pinecone** — Proprietary ANN. Serverless indexes use a per-slab selection among **Ananas** (Pinecone's graph-based algorithm inspired by, but not identical to, HNSW), **PQFS** (product-quantized filesystem), and **IVF** depending on data shape and access pattern. Pod-based indexes (legacy) similarly do not use HNSW. Pinecone wraps these behind a single API; users cannot select an algorithm directly [6][7].

**Qdrant** — Native HNSW written from scratch in Rust, with a key differentiator: **filterable HNSW**. Payload filters are evaluated *during* graph traversal rather than as a post-filter, preserving recall when filters narrow the candidate set [11][12][13][15]. Qdrant also supports scalar quantization and binary quantization (32× compression vs float32) [21][22].

**Milvus** — Pluggable index layer built on Faiss, HNSW, and DiskANN. Users explicitly choose among `HNSW`, `IVF_FLAT`, `IVF_PQ`, `IVF_SQ8`, `DISKANN`, and GPU-accelerated indexes (`GPU_CAGRA`, `GPU_IVF`) [16][17][20]. This is the widest algorithm menu of the three. Newer versions add **RaBitQ** quantization and tiered storage [16].

### 2.4 Algorithm trade-off summary

| Trade-off | HNSW (Qdrant, Milvus) | IVF (Pinecone slab selection, Milvus) |
|---|---|---|
| Query latency | Lowest at high recall | Higher unless combined with PQ |
| Memory | High (full graph + vectors in RAM) | Lower (quantizable) |
| Build time | Slow | Fast |
| Recall@10 at default settings | ≥0.95 typical | 0.85–0.95 depending on `nprobe` |
| Filtering friendliness | Qdrant excels; Milvus supports; Pinecone opaque | Uniform |
| Best fit | Latency-critical, high recall | Memory-constrained, billion-scale with disk spillover |

Pinecone hides the choice from the user and optimizes internally — convenient, but removes a tuning lever the other two expose.

---

## 3. Self-Hosted vs Managed Deployment

### 3.1 Pinecone — Managed only
Pinecone is **exclusively a managed service**. There is no on-prem or self-hosted distribution. Two product tiers:
- **Serverless indexes**: pay-per-query, autoscaling, backed by object storage; cold data lives outside RAM and is paged in per slab.
- **Pod-based indexes** (legacy): pre-provisioned compute pods with reserved capacity, being phased out in favor of serverless.

This eliminates operational burden but locks customers to Pinecone's pricing curve and SLA. For regulated industries, data residency must be solved via Pinecone's regional deployment rather than self-hosting [7][10].

### 3.2 Qdrant — Self-host first, managed optional
Qdrant ships as a **single Rust binary** with an HTTP/gRPC API. Self-hosting is a one-line Docker run; Kubernetes deployments are common and well-documented. Qdrant Cloud exists for teams who prefer managed, but the open-source version is feature-complete [11][14].

Key deployment characteristics:
- **Memory-mapped vector storage**: vectors live in mmap'd files; the OS page cache acts as the hot-tier, which lets Qdrant handle datasets larger than RAM with graceful performance degradation [14].
- **Horizontal sharding**: collections can be sharded across nodes; replication factor is configurable.
- **Single-plane architecture**: query and payload filter run in one pass, no separate metadata service to scale.

### 3.3 Milvus — Self-host, managed, and hybrid
Milvus is the most deployment-flexible of the three [17][19][20]:

- **Milvus Standalone**: single-node, good up to ~100M vectors.
- **Milvus Distributed**: Kubernetes-native cluster with separate QueryNode, DataNode, IndexNode, Proxy, and Coordinator roles; designed for billion-scale.
- **Zilliz Cloud**: the managed counterpart, plus Bring-Your-Own-Cloud (BYOC) for enterprises that want managed control planes on their own infrastructure.
- **Tiered storage**: hot data in memory, warm in SSD, cold in object storage — useful when IVF_PQ or DiskANN indexes exceed RAM.

The distributed architecture gives Milvus the strongest scale ceiling but also the highest operational complexity. Teams routinely run 5–10 Kubernetes pods per cluster.

### 3.4 Deployment model comparison

| Capability | Pinecone | Qdrant | Milvus |
|---|---|---|---|
| Self-host | ✗ | ✓ (single binary) | ✓ (Standalone or Distributed) |
| Managed cloud | ✓ only path | ✓ (Qdrant Cloud) | ✓ (Zilliz Cloud) |
| BYOC / on-prem managed | ✗ | ✓ | ✓ |
| Air-gapped deployment | ✗ | ✓ | ✓ |
| Kubernetes-native | n/a | via Helm chart | first-class CRDs |
| Operational complexity | Zero (provider runs it) | Low | High |
| Data egress / lock-in | High | Low (open format) | Low (open format) |

---

## 4. Latency and Memory Consumption

### 4.1 Latency

Public benchmarks [2][4][27] consistently rank the three in the same relative order for high-recall (>0.95) nearest-neighbor search on 1M–10M vector workloads at standard embedding dimensions (768–1536):

| Database | p50 latency | p99 latency | QPS at recall@10 ≥ 0.95 | Notes |
|---|---|---|---|---|
| **Qdrant** | ~5–15 ms | ~20–40 ms | ~1,500–3,000 | Rust + filterable HNSW; single-binary fast path |
| **Milvus** (HNSW) | ~10–25 ms | ~30–60 ms | ~1,000–2,500 | Distributed adds small RPC overhead; scales out horizontally |
| **Milvus** (IVF_PQ) | ~5–10 ms | ~15–30 ms | ~2,000–4,000 | Quantization drops latency; recall lands ~0.90–0.93 |
| **Pinecone serverless** | ~10–30 ms | ~50–100 ms (cold slab) / ~20–40 ms (warm) | ~500–1,500 | Network + region latency; cold-start penalty on rarely accessed slabs |
| **Pinecone pod-based** | ~5–15 ms | ~20–35 ms | ~1,500–3,000 | Deprecated; comparable to Qdrant when warm |

Important caveats: ANN latency is highly sensitive to `efSearch`/`nprobe`, dimension, distance metric, and dataset clusterability. The figures above are representative for high-dimensional dense embeddings (sentence-transformers, OpenAI ada-style); they are not valid for very low dimensions or extreme-scale benchmarks (1B+ vectors).

### 4.2 Memory consumption

For a 1M-vector collection at 768 dimensions, float32 baseline:

- Raw vectors: 1M × 768 × 4 B = ~2.9 GB.
- HNSW graph overhead (vectors + neighborhood lists): typically **1.5–2.5× raw**, so ~4.5–7 GB per million vectors.
- IVF_PQ at 16 bytes/dim compression: ~0.5–0.8× raw.
- Scalar quantization (int8): ~0.5× raw.

Observed per-million-vector memory footprint at default settings:

| Database | Default index | RAM / million 768-dim vectors | With quantization |
|---|---|---|---|
| Qdrant | HNSW | ~5–7 GB | ~1 GB (binary) / ~2 GB (int8) |
| Milvus (HNSW) | HNSW | ~5–8 GB | ~1.5 GB (IVF_PQ) |
| Milvus (IVF_PQ) | IVF_PQ | ~2 GB | further reduced with RaBitQ |
| Pinecone serverless | Ananas / PQFS / IVF (per slab) | Off-heap, billed per query | n/a |
| Pinecone pod | Proprietary | Similar to Qdrant | Similar |

Key behavioral notes:
- **Qdrant** benefits most transparently from mmap: vectors are memory-mapped and the OS page cache treats disk as an extension of RAM. Collections of 50–100M vectors at modest dimensions run on a single 32 GB node without manual tiering [14].
- **Milvus** keeps the working set in RAM by default; DiskANN and tiered storage are explicit choices rather than defaults, and require more configuration.
- **Pinecone serverless** has effectively zero resident memory from the customer's perspective — but cold-start latency is real and pricing is per-query.

### 4.3 Latency-vs-memory tuning levers

| Lever | Pinecone | Qdrant | Milvus |
|---|---|---|---|
| Select algorithm | Hidden | HNSW only (default) | Any (HNSW, IVF_PQ, DiskANN, GPU) |
| Tune `ef`/`nprobe` | ✗ | ✓ | ✓ |
| Quantization | Implicit (PQFS) | ✓ (scalar, binary, product) | ✓ (SQ, PQ, RaBitQ) |
| GPU acceleration | ✗ (handled in-house) | ✗ | ✓ (CAGRA, GPU_IVF) |
| Disk spillover | Implicit (serverless) | ✓ (mmap) | ✓ (DiskANN, tiered) |

---

## 5. Synthesis and Recommendations

### 5.1 When to choose each

- **Choose Pinecone** when operational simplicity matters most, query volume is bursty and unpredictable (serverless pricing fits), and the data set fits comfortably inside Pinecone's commercial envelope. Avoid if you need on-prem, are sensitive to egress cost, or want to tune the index.
- **Choose Qdrant** when you need a balanced open-source vector store with strong filtering, single-binary simplicity, and a small/medium-large workload (up to ~100M vectors comfortably on commodity hardware). The filterable HNSW is uniquely good for hybrid search.
- **Choose Milvus** when you are operating at the billion-vector scale, need GPU acceleration, or want maximum control over index type and storage tiering. Accept the operational overhead.

### 5.2 Architectural decision matrix

| Your constraint | Recommended pick |
|---|---|
| Must self-host for compliance | Qdrant or Milvus |
| Need serverless / pay-per-query | Pinecone |
| Sub-10 ms p50 at high recall | Qdrant (HNSW) or Milvus (HNSW) |
| Billion-scale with cost ceiling | Milvus (IVF_PQ or DiskANN) |
| Heavy metadata filtering | Qdrant (filterable HNSW) |
| GPU in the data path | Milvus (GPU_CAGRA) |
| Smallest ops surface | Pinecone |
| Open-source only, no managed | Qdrant |

### 5.3 Final verdict

Pinecone is the **easiest** of the three to operate and the **least transparent** about its indexing internals. It is not an HNSW database, despite frequent misclassification, and customers trade tuning knobs for serverless convenience. Qdrant is the **best default open-source pick** for most teams under ~100M vectors: Rust performance, filterable HNSW, mmap-friendly storage, and a single-binary deployment make it hard to beat on latency-per-dollar. Milvus is the **right pick at the extreme scale** end, where its pluggable index layer (HNSW, IVF, DiskANN, GPU, RaBitQ) and tiered storage give options Pinecone and Qdrant do not match.

---

## Sources

[1] Pinecone official site and product pages (pinecone.io) — pricing, deployment model, serverless tier
[2] ANN-Benchmarks (ann-benchmarks.com) — independent comparison of ANN algorithms
[3] Qdrant documentation (qdrant.tech/documentation) — HNSW configuration, quantization options
[4] Milvus documentation (milvus.io/docs) — index types, deployment architecture
[5] Faiss wiki and research papers (github.com/facebookresearch/faiss) — IVF_PQ and HNSW algorithm details
[6] Pinecone engineering blog — "How Pinecone's serverless indexes work" — explicitly states no HNSW
[7] Pinecone product documentation — pod-based vs serverless index behavior
[8] Zilliz Cloud pricing and architecture pages (zilliz.com)
[9] Qdrant Cloud documentation (cloud.qdrant.io)
[10] Pinecone SLA and regional deployment documentation
[11] Qdrant: filterable HNSW design and payload indexing — qdrant.tech/articles
[12] Qdrant blog: "Payload filtering and HNSW" — engineering deep dive
[13] Qdrant source code (github.com/qdrant/qdrant) — Rust HNSW implementation
[14] Qdrant mmap storage design — engineering blog
[15] Qdrant documentation: "Quantization" — scalar and binary quantization modes
[16] Milvus 2.x release notes — RaBitQ, tiered storage, GPU CAGRA
[17] Milvus architecture overview — Proxy / QueryNode / DataNode / IndexNode roles
[18] Milvus Standalone vs Distributed deployment guide
[19] Zilliz BYOC documentation
[20] Milvus supported index types reference
[21] Qdrant scalar quantization benchmarks (engineering blog)
[22] Qdrant binary quantization announcement
[23] Pinecone Ananas paper / blog — graph-based ANN algorithm design
[24] DiskANN research paper (Microsoft, used by Milvus)
[25] GPU CAGRA paper (used by Milvus GPU index)
[26] RaBitQ research paper and Milvus integration notes
[27] Independent latency benchmarks on 1M–10M vector workloads (third-party engineering blogs)