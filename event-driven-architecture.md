# Event-Driven Architecture: Kafka vs RabbitMQ vs AWS SQS

## Overview

Event-driven systems decouple producers from consumers by routing events through a broker. The three options below differ fundamentally in their model.

- **Apache Kafka** is a distributed, partitioned, append-only log optimised for high-throughput, replayable event streaming.
- **RabbitMQ** is a general-purpose AMQP broker that routes messages through exchanges into queues with flexible routing rules.
- **AWS SQS** is a fully managed, serverless queue service integrated with the AWS ecosystem. It offers a Standard variant (at-least-once, best-effort ordering) and a FIFO variant (exactly-once, strict ordering per group).

The right choice depends on scale, delivery guarantees, ordering requirements, and whether you operate the infrastructure yourself or consume it as a service.

## Comparison

| Dimension | Apache Kafka | RabbitMQ | AWS SQS |
|---|---|---|---|
| **Core model** | Distributed partitioned commit log; consumers track their own offset | Smart broker with exchange/queue topology; broker delivers to consumers | Managed queue service; producers enqueue, consumers poll |
| **Architecture** | Broker cluster; topic partitioned across nodes (ZooKeeper or KRaft for coordination) | Cluster of nodes with mirrored or quorum queues; clients connect to any node | Serverless; no servers to manage; integrates with IAM, CloudWatch, Lambda |
| **Throughput (typical)** | Very high — roughly 100K–1M+ msgs/sec per cluster; scales by adding partitions | Moderate — roughly 1K–50K msgs/sec; depends on durability and ack settings | Standard: nearly unlimited with batching. FIFO: 300 msg/s, 3,000/s with batching; quotas increasable on request |
| **Ordering** | Per-partition FIFO; global order only with a single partition | FIFO per queue; preserved while a single consumer drains the queue | Standard: best-effort, no guarantee. FIFO: strict, scoped to a `MessageGroupId` |
| **Delivery guarantee** | At-least-once by default; exactly-once with transactions and idempotent producers | At-most-once, at-least-once, or exactly-once with publisher confirms and acks | Standard: at-least-once. FIFO: exactly-once processing |
| **Message retention** | Days to weeks, configurable; log-style replay | Until acknowledged, then deleted; no replay | Up to 14 days; deleted after acknowledgement or expiry |
| **Replay** | Yes — consumers re-read the log from any offset | No — messages removed once consumed | No — messages removed once consumed |
| **Routing** | Topic-based; minimal native routing semantics | Rich: direct, topic, fanout, headers, dead-letter exchanges | None at the broker; per-message fanout is the caller's job; FIFO groups partition traffic |
| **Operations burden** | High — cluster, partitions, rebalancing, coordination choice | Medium — cluster, queue policies, consumer prefetch tuning | Low — fully managed |
| **Lock-in** | None (self-hosted; several managed offerings) | None (self-hosted; several managed offerings) | High — AWS-only |

Throughput numbers above are typical orders of magnitude from general knowledge, not current vendor benchmarks. Verify against your workload if these are decision-critical.

## Trade-offs

### Apache Kafka

**Strengths.** Highest throughput of the three. The log model gives replay, lets new consumers read historical events, and supports stream-processing frameworks (Kafka Streams, Flink, ksqlDB) directly against the broker. Per-partition ordering scales with the number of partitions.

**Weaknesses.** Operationally heavy: you run a cluster, tune partition counts, manage rebalances, and choose between ZooKeeper and KRaft for metadata. The "smart consumer" model is unfamiliar to teams used to broker-push systems. Over-provisioning partitions is hard to undo without re-partitioning.

**Choose when** you need high throughput, durable event history, replay, or stream processing. Typical fit: analytics pipelines, event sourcing, log aggregation, change-data-capture.

### RabbitMQ

**Strengths.** Most flexible routing of the three — exchanges, bindings, and dead-letter exchanges let you shape delivery precisely. Lower latency at moderate loads. Mature AMQP protocol and broad client language support. Good fit when the broker is in the critical path of business logic that needs complex routing or RPC-style patterns.

**Weaknesses.** Throughput is materially lower than Kafka. Messages are deleted on consumption, so there is no replay. Clustering is less proven at very large scale; performance and consistency trade-offs vary with queue type (classic vs quorum).

**Choose when** you need rich routing, per-message acknowledgements, and moderate throughput without the operational footprint of Kafka. Typical fit: task queues, microservice command channels, work distribution.

### AWS SQS

**Strengths.** Zero operations. Scales transparently. IAM, CloudWatch, Lambda triggers, and dead-letter queues are first-class. Low cost at low-to-moderate volume. FIFO queues give exactly-once and ordering without standing up infrastructure.

**Weaknesses.** No replay, no streaming, no log-style retention. Throughput is bound by API quotas, especially on FIFO. Standard queues give only at-least-once and no ordering — dedupe and partitioning logic land in your code. AWS-only; portability requires redesign.

**Choose when** you want a managed queue, are deeply on AWS, and do not need replay or high-volume streaming. Typical fit: decoupling Lambda or service tasks, throttling, simple work distribution.

## Selecting Between Them

The choice is rarely about which is "best" — it is about which model matches the workload.

- Need replay, high throughput, or stream processing → Kafka.
- Need flexible routing, moderate throughput, and portable deployment → RabbitMQ.
- Need a managed queue with no ops and AWS-native integration → SQS.

A common hybrid pattern: Kafka as the event backbone (pub/sub, replay, analytics), with SQS or RabbitMQ at the edges for per-service work queues and targeted fanout to specific workers.