# Monitoring verification

The implementation used for Host Pulse was verified on a Linux host with 16 logical CPUs, BB 0.48.1 and Plugin SDK 0.6.104 on 2026-11-05. These are short local measurements, not a long-running soak test or a performance guarantee.

The production host collector was run with a test SDK, real system counters and a bounded history of 72 readings. Across 100 repeated forced samples, mean collection time was 43.3 ms, median 42.4 ms, p95 53.2 ms and maximum 62.3 ms. The process used about 26 ms CPU per sample; child-process CPU was not measured separately. A preceding run had one unexplained 4.7-second delay that did not recur in the repeat. Full snapshots were approximately 13–14 KB.

The timed RPC client and output validation averaged 0.054–0.064 ms over two runs of 1,000 calls in Node. That excludes network and browser rendering. An actual HTTP response that sent headers but stalled its body was aborted after 30 seconds, marked stale and recovered on the next retry.

The compact layout was checked at 390 px and 220 px viewport widths and with text enlarged to 125%. Visible text rectangles did not overlap. Lifecycle tests cover shared requests, closing views, cancellation, bounded history and idle polling.

The separate optional background monitor samples only CPU and memory. Its existing benchmark can be run with `node --expose-gc benchmarks/monitor.mjs 100`. A 100-cycle run after warmup averaged 0.737 ms per cycle and recorded no writes after shutdown.

Historical benchmark results in `benchmarks/` belong to upstream Beacon; see `NOTICE.md`. Run the included test suite and benchmarks on the target host to assess different workloads.

## Refresh scheduling, 2026-11-07

A cached response restarted a viewer's full polling interval after reopening. With a five-second interval, reopening at 3.47 seconds left the first CPU reading visible at 6.1 seconds without another request. The shared snapshot source now exposes its existing refresh/retry deadline to all three polling hooks. The same browser scenario then requested the next reading at 5.008 seconds. Five regression tests cover the 5/10/60-second cadences, staggered viewers sharing one request, and recovery after reopening during offline backoff. The installed-UI regression is `tests/browser/floating-monitor-refresh.js`.

A separate 100-sample run of the real collector on BB 0.49.0 measured mean 43.7 ms, p95 76.2 ms and maximum 123.3 ms, with no sample exceeding 250 ms. These local timings exclude the user's network and device. They do not rule out other sources of intermittent delay.
