#!/usr/bin/env python
"""Predice con un checkpoint de Laya las filas de un JSONL de evaluación (las mismas que usa laya-train).

Uso (con el python del venv de Laya):
    python bin/laya-evaluar.py eval.jsonl MODELO salida.json

MODELO es un alias (multilingual) o la carpeta de un checkpoint. Escribe en salida.json la lista de
elecciones, una por fila y en el mismo orden. Lo lanza `router laya-entrenar`; no habla con el servicio.
"""
import json
import sys

import laya


def main(data_path, model, out_path):
    with open(data_path, encoding="utf-8") as f:
        rows = [json.loads(line) for line in f if line.strip()]
    agent = laya.load(model)
    preds = []
    for row in rows:
        result = agent.system_one(row["state"], row["questions"])
        qid = next(iter(row["expected"]))
        preds.append(result[qid]["choice"])
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(preds, f)


if __name__ == "__main__":
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(*sys.argv[1:])
