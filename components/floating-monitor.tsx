import { useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import { useServerSnapshot } from "../hooks/use-server-snapshot";
import { floatingMonitor, useFloatingMonitor } from "../hooks/use-floating-monitor";
import { clampMonitorPosition, type MonitorPosition } from "../lib/floating-monitor-state";
import { colorForPercent, formatBytes } from "../lib/format-metrics";
import { openServerStatus } from "../lib/status-disclosure";
import { ProviderUsage } from "./provider-usage";
import { DeepseekBalance } from "./deepseek-balance";

function viewport() {
  const v = window.visualViewport;
  return { left: v?.offsetLeft ?? 0, top: v?.offsetTop ?? 0, width: v?.width ?? window.innerWidth, height: v?.height ?? window.innerHeight };
}

function Metric({ label, value, title }: { label: string; value: number | null; title?: string }) {
  return <div className="host-pulse-float-metric" title={title}>
    <span>{label}</span>
    <strong>{value === null ? "–" : `${Math.round(value)}%`}</strong>
    <div className="host-pulse-float-meter" aria-hidden="true"><i style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%`, background: colorForPercent(value) }} /></div>
  </div>;
}

function ProcessLeader({ label, process, value, title }: { label: string; process: { pid: number; name: string } | null | undefined; value: string; title: string }) {
  return <div className="host-pulse-float-row host-pulse-float-process" title={title} aria-label={`${label} leader: ${process ? `${process.name}, PID ${process.pid}, ${value}` : "unavailable"}`}>
    <span className="host-pulse-float-label">{label}</span>
    <span className="host-pulse-float-process-name">{process ? <><span>{process.name}</span><small>#{process.pid}</small></> : "–"}</span>
    <strong>{value}</strong>
  </div>;
}

function percent(value: number | null | undefined) {
  return value == null ? "–" : `${value > 0 && value < 10 ? value.toFixed(1) : Math.round(value)}%`;
}

function operations(value: number | null) {
  if (value === null) return "–";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return value > 0 && value < 10 ? value.toFixed(1) : String(Math.round(value));
}

function FloatingCard() {
  const { container, snapshot, error, active } = useServerSnapshot();
  const [position, setPosition] = useState(floatingMonitor.getSnapshot().position);
  const positionRef = useRef(position);
  const [limits, setLimits] = useState(viewport);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; origin: MonitorPosition } | null>(null);

  const move = (next: MonitorPosition) => {
    const size = container.current?.getBoundingClientRect() ?? { width: 252, height: 132 };
    const clamped = clampMonitorPosition(next, viewport(), size);
    positionRef.current = clamped;
    setPosition(clamped);
    return clamped;
  };

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const fit = () => {
      const bounds = viewport();
      setLimits(bounds);
      const size = element.getBoundingClientRect();
      const next = clampMonitorPosition(positionRef.current ?? { x: bounds.left + bounds.width - size.width - 16, y: bounds.top + 64 }, bounds, size);
      positionRef.current = next;
      setPosition(next);
      floatingMonitor.setPosition(next);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    window.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("resize", fit);
    window.visualViewport?.addEventListener("scroll", fit);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("resize", fit);
      window.visualViewport?.removeEventListener("scroll", fit);
    };
  }, [container]);

  const startDrag = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0 || !event.isPrimary || !positionRef.current) return;
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, origin: positionRef.current };
    setDragging(true);
  };
  const dragMove = (event: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    move({ x: d.origin.x + event.clientX - d.x, y: d.origin.y + event.clientY - d.y });
  };
  const finishDrag = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const d = drag.current;
    if (!d || d.id !== event.pointerId) return;
    drag.current = null;
    if (cancel) move(d.origin);
    if (positionRef.current) floatingMonitor.setPosition(positionRef.current);
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const keyMove = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Escape" && drag.current) {
      const d = drag.current;
      drag.current = null;
      floatingMonitor.setPosition(move(d.origin));
      setDragging(false);
      if (event.currentTarget.hasPointerCapture(d.id)) event.currentTarget.releasePointerCapture(d.id);
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!delta || !positionRef.current || drag.current) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 1 : 10;
    floatingMonitor.setPosition(move({ x: positionRef.current.x + delta[0] * step, y: positionRef.current.y + delta[1] * step }));
  };
  const rate = (value: number | null | undefined) => value == null ? "–" : `${formatBytes(value)}/s`;
  const cores = snapshot?.cpu.perCoreUsagePercent ?? Array.from({ length: 16 }, () => null);
  const io = snapshot?.diskIo;
  const iops = io?.readIops != null && io.writeIops != null ? io.readIops + io.writeIops : null;
  const topCpu = snapshot?.processes.topCpu;
  const topMemory = snapshot?.processes.topMemory;

  return <div ref={container} data-host-pulse-floating role="region" aria-label="Host Pulse floating server monitor"
    className="host-pulse-float" data-dragging={dragging || undefined}
    style={{ left: position?.x, top: position?.y ?? 64, right: position ? undefined : 16, maxWidth: Math.max(0, limits.width - 16), maxHeight: Math.max(0, limits.height - 16) }}>
    <div className="host-pulse-float-header">
      <button type="button" className="host-pulse-float-handle" aria-label="Move Host Pulse monitor" title="Drag to move · Arrow keys: 10px · Shift + arrows: 1px"
        onPointerDown={startDrag} onPointerMove={dragMove} onPointerUp={finishDrag} onPointerCancel={(event) => finishDrag(event, true)} onLostPointerCapture={finishDrag} onKeyDown={keyMove}>
        <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true"><circle cx="3" cy="3" r="1" /><circle cx="7" cy="3" r="1" /><circle cx="3" cy="7" r="1" /><circle cx="7" cy="7" r="1" /><circle cx="3" cy="11" r="1" /><circle cx="7" cy="11" r="1" /></svg>
        <span>Host Pulse</span>
      </button>
      <span className="host-pulse-float-status" title={error ?? (snapshot ? `${snapshot.host.hostname} · ${snapshot.timestamp}` : "Waiting for server data")} role="status">{error ? "Retrying" : snapshot ? "Live" : "Loading"}</span>
      <button type="button" className="host-pulse-float-action" aria-label="Open server details" title="Open server details" onClick={openServerStatus}><Icon name="ArrowUpRight" className="size-3.5" aria-hidden /></button>
      <button type="button" className="host-pulse-float-action" aria-label="Hide floating monitor" title="Hide · reopen with Pin monitor in Server status" onClick={() => floatingMonitor.setVisible(false)}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg></button>
    </div>
    <div className="host-pulse-float-metrics">
      <Metric label="CPU" value={snapshot?.cpu.usagePercent ?? null} title="Processor usage across all cores" />
      <Metric label="RAM" value={snapshot?.memory.usagePercent ?? null} title={snapshot ? `${formatBytes(snapshot.memory.usedBytes)} of ${formatBytes(snapshot.memory.totalBytes)}` : "Memory usage"} />
      <Metric label="Space" value={snapshot?.disk?.usagePercent ?? null} title={snapshot?.disk ? `Root disk space used · ${formatBytes(snapshot.disk.freeBytes)} free on /` : "Root disk unavailable"} />
    </div>
    <div className="host-pulse-float-cores" aria-label={`Load of ${snapshot?.cpu.cores ?? 16} CPU cores`} style={{ gridTemplateColumns: `repeat(${Math.min(16, Math.max(1, cores.length))}, minmax(0, 1fr))` }}>
      {cores.map((value, index) => <span key={index} className="host-pulse-float-core" role="img" aria-label={`Core ${index + 1}: ${percent(value)}`} title={`Core ${index + 1}: ${percent(value)}`}>
        <i style={{ height: `${Math.min(100, Math.max(0, value ?? 0))}%`, background: colorForPercent(value) }} />
      </span>)}
    </div>
    <div className="host-pulse-float-row host-pulse-float-io" aria-label="Disk I/O activity" title={io ? `${io.device} · time busy, not space used · ${operations(io.readIops)} reads/s + ${operations(io.writeIops)} writes/s · read ${rate(io.readBytesPerSecond)}, write ${rate(io.writeBytesPerSecond)}` : "Disk activity unavailable; needs Linux block-device counters"}>
      <span className="host-pulse-float-label">I/O</span><strong>{percent(io?.busyPercent)}</strong><span className="host-pulse-float-io-ops">{operations(iops)} IOPS</span>
    </div>
    <div className="host-pulse-float-row host-pulse-float-network" aria-label="Network speed" title={snapshot?.network ? `Interface: ${snapshot.network.interface} · bytes per second` : "Network rates unavailable"}>
      <span className="host-pulse-float-label">NET</span>
      <span aria-label={`Download: ${rate(snapshot?.network?.rxBytesPerSecond)}`}>↓ {rate(snapshot?.network?.rxBytesPerSecond)}</span>
      <span aria-label={`Upload: ${rate(snapshot?.network?.txBytesPerSecond)}`}>↑ {rate(snapshot?.network?.txBytesPerSecond)}</span>
    </div>
    <div className="host-pulse-float-processes" aria-label="Top processes">
      <ProcessLeader label="CPU" process={topCpu} value={percent(topCpu?.cpuPercent)} title={topCpu ? `${topCpu.name} · PID ${topCpu.pid} · ${topCpu.cpuPercent.toFixed(2)}% of total host CPU over the last interval (100% = all ${snapshot?.cpu.cores} cores)` : "Top CPU process needs two readable Linux samples"} />
      <ProcessLeader label="RAM" process={topMemory} value={topMemory ? formatBytes(topMemory.rssBytes) : "–"} title={topMemory ? `${topMemory.name} · PID ${topMemory.pid} · ${formatBytes(topMemory.rssBytes)} resident memory · largest among all readable processes` : "Top memory process unavailable"} />
    </div>
    <ProviderUsage active={active} />
    <DeepseekBalance active={active} />
    {error ? <div className="host-pulse-float-error">Reconnecting · {snapshot ? "showing last reading" : "data unavailable"}</div> : null}
  </div>;
}

export function FloatingMonitor() {
  const { visible } = useFloatingMonitor();
  return visible ? createPortal(<FloatingCard />, document.body) : null;
}
