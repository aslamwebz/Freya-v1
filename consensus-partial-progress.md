# Distributed Consensus: Raft vs Paxos

A concise snapshot of where we are on comparing these two algorithms.

## What they solve
Both let a cluster of machines agree on a single sequence of commands (a replicated log) even when some nodes fail or messages are delayed. This is the core of strongly consistent systems like etcd, CockroachDB, Spanner's per-paxos groups, and Kafka's KRaft mode.

## Raft (Ongaro & Ousterhout, 2014)
Designed to be understandable. One leader at a time drives replication; followers acknowledge entries. Safety rests on:
- **Leader election** with randomized timeouts (avoids split votes).
- **Log matching**: if two entries share an index and term, they are identical and prefix-matched.
- **Commit rule**: a leader commits an entry once it is replicated to a majority and remains leader for at least one more term.
- **Election restriction**: a candidate's log must be at least as up-to-date as a majority's, preventing stale leaders from overwriting committed entries.

Typical implementation: ~1500–2000 lines.

## Paxos (Lamport, 1998) and variants
Lamport's original paper is famously hard to read; the field treats **Multi-Paxos** as the practical form.
- **Roles** (logical, not per-node): Proposer, Acceptor, Learner. A stable Proposer plays the leader role.
- **Phases per slot**: Prepare (request a quorum to promise not to accept older proposals) → Accept (propose a value, gather a quorum of acceptances) → Chosen (a value is chosen once a majority has accepted it).
- **Multi-Paxos** skips Prepare in the common case once a leader is stable, leaving one round trip per command — similar in steady-state cost to Raft.

Variants worth knowing:
- **Cheap Paxos / Flexible Paxos**: relax the majority quorum (e.g. FQUORUM = 2f + 1 vs. read quorum f + 1) for cheaper fault tolerance trade-offs.
- **EPaxos / Mencius**: leaderless or rotating-leader designs for lower latency at the cost of more complex dependencies between commands.

## Key differences

| Aspect | Raft | Multi-Paxos |
|---|---|---|
| Design goal | Understandability | Minimal theory |
| Leadership | Strong, explicit | Logical proposer, often stable in practice |
| Steady-state RTTs per command | 1 (AppendEntries → reply) | 1 (Accept → reply) |
| Cluster membership change | Joint consensus built-in | Not in original; added later |
| Log structure | Single, ordered, restrictive election rule | Proposers can propose any value, log can have gaps |
| Typical complexity | Lower in practice | Higher; many subtle published bugs |

## Open questions / next steps for the comparison
- Performance under contention and leader failure (election storms, duplicate Prepare storms).
- Correctness proofs side-by-side — especially around the "no committed entry can be lost" invariant.
- Implementation ecosystems: Raft has canonical impls (etcd-raft, hashicorp/raft); Paxos impls are more fragmented (Chubby, Megastore's Paxos, ZooKeeper's ZAB, a related-but-different protocol).
- Real-world failure modes: clock drift assumptions, network partitions, snapshotting cost.

## TL;DR
Raft and Multi-Paxos reach the same steady-state efficiency and the same safety guarantees. Raft wins on clarity and ecosystem; Paxos wins on theoretical flexibility (and is the substrate most academic variants build on).