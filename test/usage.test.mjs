import { describe, it, expect } from "vitest";
import { usageFromTranscript, advanceUsage, startUsage } from "../src/core/usage.mjs";

const line = (o) => JSON.stringify(o);
const asst = (id, model, usage, extra = {}) => line({ type: "assistant", message: { id, model, usage }, ...extra });
const u = (input, output, extra = {}) => ({ input_tokens: input, output_tokens: output, ...extra });

describe("usageFromTranscript", () => {
  it("suma el uso por modelo en la forma normalizada de pricing", () => {
    const text = [
      asst("m1", "claude-opus-5-5", u(10, 5, { cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 } })),
      asst("m2", "claude-opus-5-5", u(1, 2)),
      asst("m3", "claude-haiku-5-5", u(4, 4, { cache_creation_input_tokens: 9 }))
    ].join("\n");
    expect(usageFromTranscript(text, { sidechain: false }).byModel).toEqual({
      "claude-opus-5-5": { input: 11, output: 7, cacheRead: 100, cacheWrite5m: 7, cacheWrite1h: 3 },
      "claude-haiku-5-5": { input: 4, output: 4, cacheRead: 0, cacheWrite5m: 9, cacheWrite1h: 0 }
    });
  });

  it("deduplica por message.id quedándose con la última línea", () => {
    const text = [asst("m1", "claude-opus-5-5", u(10, 1)), asst("m1", "claude-opus-5-5", u(10, 50))].join("\n");
    expect(usageFromTranscript(text, { sidechain: false }).byModel["claude-opus-5-5"]).toMatchObject({ input: 10, output: 50 });
  });

  it("sidechain:false descarta lo del subagente; sidechain:true lo acepta todo", () => {
    const text = [asst("m1", "claude-opus-5-5", u(1, 1)), asst("m2", "claude-sonnet-5-5", u(5, 5), { isSidechain: true })].join("\n");
    expect(Object.keys(usageFromTranscript(text, { sidechain: false }).byModel)).toEqual(["claude-opus-5-5"]);
    expect(Object.keys(usageFromTranscript(text, { sidechain: true }).byModel).sort()).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  it("ignora líneas rotas, ajenas, sin uso y el modelo <synthetic>", () => {
    const text = [
      'cortada a medias"}}',
      line({ type: "user", message: { content: "hola" } }),
      asst("s", "<synthetic>", u(9, 9)),
      line({ type: "assistant", message: { id: "x", model: "claude-opus-5-5" } }),
      asst("m1", "claude-opus-5-5", u(2, 3)),
      ""
    ].join("\n");
    expect(usageFromTranscript(text, { sidechain: false })).toEqual({ byModel: { "claude-opus-5-5": { input: 2, output: 3, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 } } });
  });

  it("sin datos devuelve byModel vacío", () => {
    expect(usageFromTranscript("", { sidechain: true })).toEqual({ byModel: {} });
    expect(usageFromTranscript(undefined, { sidechain: true })).toEqual({ byModel: {} });
  });
});

describe("advanceUsage: lectura incremental idéntica a leer todo", () => {
  const lines = [
    asst("m1", "claude-opus-5-5", u(10, 1)),
    asst("m1", "claude-opus-5-5", u(10, 50)),
    line({ type: "user", message: { content: "x" } }),
    asst("m2", "claude-haiku-5-5", u(3, 3)),
    asst("m3", "claude-opus-5-5", u(1, 1), { isSidechain: true }),
    asst("m4", "claude-opus-5-5", u(7, 7)),
    asst("m5", "claude-opus-5-5", u(2, 2)),
    asst("m4", "claude-opus-5-5", u(7, 70)), // m4 vuelve a aparecer, intercalado con m5
    asst("m6", "claude-opus-5-5", u(4, 4)),
    asst("m6", "claude-opus-5-5", u(4, 40))
  ];
  const full = lines.join("\n") + "\n";

  // Lee `full` en trozos por bytes (también a mitad de línea), igual que haría el hook entre llamadas.
  function readInChunks(cuts, opts) {
    const buf = Buffer.from(full);
    let st = startUsage(0);
    let usage;
    let prev = 0;
    for (const cut of [...cuts, buf.length]) {
      ({ state: st, usage } = advanceUsage(st, buf.subarray(st.offset, cut).toString("utf8"), opts));
      prev = cut;
    }
    return { usage, st, prev };
  }

  it("da lo mismo que usageFromTranscript con cualquier corte, incluido uno partiendo un message.id", () => {
    const expected = usageFromTranscript(full, { sidechain: false });
    const bytes = Buffer.byteLength(full);
    for (let cut = 1; cut < bytes; cut += 37) {
      expect(readInChunks([cut], { sidechain: false }).usage).toEqual(expected);
    }
    for (const cuts of [[100, 101, 400], [lines[0].length + 1, lines[0].length + lines[1].length + 2], [bytes - 5]]) {
      expect(readInChunks(cuts, { sidechain: false }).usage).toEqual(expected);
    }
  });

  it("un message.id partido entre dos lecturas: gana la última línea", () => {
    const first = [asst("m1", "claude-opus-5-5", u(10, 1))].join("\n") + "\n";
    const second = asst("m1", "claude-opus-5-5", u(10, 99)) + "\n";
    const a = advanceUsage(startUsage(0), first);
    expect(a.usage.byModel["claude-opus-5-5"]).toMatchObject({ output: 1 });
    const b = advanceUsage(a.state, second);
    expect(b.usage.byModel["claude-opus-5-5"]).toMatchObject({ input: 10, output: 99 });
  });

  it("la última línea sin salto de línea cuenta en el resultado pero no se consume", () => {
    const text = asst("m1", "claude-opus-5-5", u(1, 1)) + "\n" + asst("m2", "claude-opus-5-5", u(2, 2));
    const { state, usage } = advanceUsage(startUsage(0), text);
    expect(usage.byModel["claude-opus-5-5"]).toMatchObject({ input: 3 });
    expect(state.offset).toBe(Buffer.byteLength(asst("m1", "claude-opus-5-5", u(1, 1)) + "\n"));
    // Al completarse la línea no se cuenta dos veces.
    const done = advanceUsage(state, asst("m2", "claude-opus-5-5", u(2, 2)) + "\n");
    expect(done.usage.byModel["claude-opus-5-5"]).toMatchObject({ input: 3 });
  });

  it("el estado es JSON (va a la sesión) y acotado aunque haya miles de mensajes", () => {
    let st = startUsage(5);
    const text = Array.from({ length: 5000 }, (_, i) => asst(`id${i}`, "claude-opus-5-5", u(1, 1))).join("\n") + "\n";
    const r = advanceUsage(st, text);
    expect(r.usage.byModel["claude-opus-5-5"]).toMatchObject({ input: 5000, output: 5000 });
    expect(JSON.stringify(r.state).length).toBeLessThan(10_000);
    expect(JSON.parse(JSON.stringify(r.state))).toEqual(r.state);
    expect(r.state.offset).toBe(5 + Buffer.byteLength(text));
  });
});
