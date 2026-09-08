# Initial performance fixture

`Thousand_node_fixture_polls_and_pages_through_bounded_queries` seeds 1,000
registered Nodes and active credentials in PostgreSQL, then calls the
coordination interface with bounded concurrency. It also reads all Nodes through
five pages of 200. It verifies the no-work polling case and complete pagination.

One local run on 2026-09-07 measured 1.266 seconds for the polls and 1.301 seconds
including the pages. The environment was a NixOS Linux development host, .NET
10.0.302, and PostgreSQL 17.5 in Docker. Host contention was not controlled and
hardware capacity was not recorded, so these measurements are diagnostic only.

The fixture does not measure HTTP/TLS overhead, assigned-work payloads, Bundle
downloads, long-running regular polling, publication throughput, p95/p99 latency,
or restart recovery. It is not a capacity guarantee or a release performance
gate. Those scenarios need declared hardware, representative content sizes, and
agreed thresholds before release.
