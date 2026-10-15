// Conexión con el servidor: hello con las ejecuciones reducidas y luego eventos sueltos.
import { useEffect, useRef, useState } from "react";
import { reduceRun } from "../../src/core/reducer.mjs";

export function useLive(onEvent) {
  const [runs, setRuns] = useState({});
  const [quotas, setQuotas] = useState({});
  const [connection, setConnection] = useState("connecting");
  const [epoch, setEpoch] = useState(0); // sube con cada hello: marca la carga inicial/reconexión
  const runsRef = useRef({});
  const onEventRef = useRef(onEvent);
  useEffect(() => { onEventRef.current = onEvent; }, [onEvent]);

  useEffect(() => {
    let socket;
    let retry;
    let closed = false;

    const connect = () => {
      const scheme = location.protocol === "https:" ? "wss" : "ws";
      socket = new WebSocket(`${scheme}://${location.host}/ws`);
      socket.onopen = () => setConnection("connected");
      socket.onclose = () => {
        setConnection("disconnected");
        if (!closed) retry = setTimeout(connect, 1500);
      };
      socket.onmessage = (msg) => {
        let data;
        try { data = JSON.parse(msg.data); } catch { return; }
        if (data.kind === "hello") {
          runsRef.current = Object.fromEntries(data.runs.map((r) => [r.id, r]));
          setRuns(runsRef.current);
          setQuotas(data.quotas ?? {});
          setEpoch((e) => e + 1);
        } else if (data.kind === "event") {
          const { runId, event } = data;
          if (event.type === "quota") setQuotas((q) => ({ ...q, [event.profile ?? "trabajo"]: event }));
          const run = reduceRun(runsRef.current[runId] ?? null, event);
          if (!run) return;
          runsRef.current = { ...runsRef.current, [runId]: run };
          setRuns(runsRef.current);
          onEventRef.current?.(runId, event, run);
        }
      };
    };

    connect();
    return () => { closed = true; clearTimeout(retry); socket?.close(); };
  }, []);

  return { runs, quotas, connection, epoch };
}
