import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import ExcelJS from "exceljs";
import compression from "compression";
import helmet from "helmet";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { LRUCache } from "lru-cache";

const app = express();

// =========================
// Config
// =========================
const PORT = Number(process.env.PORT || 3000);

// Página "antiga" do RAB (responde com dados pela matrícula via querystring textMarca)
const ANAC_RAB_URL =
  process.env.ANAC_RAB_URL ||
  "https://aeronaves.anac.gov.br/aeronaves/cons_rab_resposta.asp";

// Cache simples (evita martelar o site)
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60 * 60 * 1000); // 1h
const cache = new LRUCache({
  max: 2000,
  ttl: CACHE_TTL_MS,
});

// Segurança/observabilidade básica
app.set("trust proxy", true);
app.use(helmet());
app.use(compression());
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// Rate limit por IP (ajuste se necessário)
app.use(
  rateLimit({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000),
    max: Number(process.env.RATE_LIMIT_MAX || 60),
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Frontend estático
app.use(express.static("public"));

// =========================
// Helpers
// =========================
function normalizeMarca(marca) {
  return String(marca || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

// O HTML costuma vir em ISO-8859-1/Windows-1252 (latin1)
async function fetchRabHtml(marca) {
  const cached = cache.get(marca);
  if (cached) return cached;

  const resp = await axios.get(ANAC_RAB_URL, {
    params: { textMarca: marca },
    responseType: "arraybuffer",
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 25_000,
    validateStatus: (s) => s >= 200 && s < 400,
  });

  const html = Buffer.from(resp.data).toString("latin1");
  cache.set(marca, html);
  return html;
}

function parseRabHtml(html) {
  const $ = cheerio.load(html, { decodeEntities: false });

  // Tentativa de detectar quando a matrícula não existe
  const bodyText = $("body").text().replace(/\s+/g, " ").trim().toLowerCase();
  const notFoundHints = [
    "não encontrada",
    "nao encontrada",
    "nenhum registro",
    "nenhuma aeronave",
    "não existe",
    "nao existe",
  ];
  const maybeNotFound = notFoundHints.some((h) => bodyText.includes(h));

  const fields = {};

  // Pega pares "Campo / Valor" em tabelas (muitas linhas são td/td)
  $("table tr").each((_, tr) => {
    const tds = $(tr).find("td");
    if (tds.length >= 2) {
      const key = $(tds[0])
        .text()
        .replace(/\s+/g, " ")
        .trim()
        .replace(/:$/, "");
      const val = $(tds[1]).text().replace(/\s+/g, " ").trim();

      if (key && val) fields[key] = val;
    }
  });

  // Links úteis que porventura apareçam no HTML
  const links = [];
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    const text = $(a).text().replace(/\s+/g, " ").trim();
    if (!href || !text) return;
    links.push({ text, href });
  });

  return { fields, links, maybeNotFound };
}

function toSafeFilename(s) {
  return String(s || "arquivo")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(0, 120);
}

// =========================
// API
// =========================
app.get("/api/aeronave", async (req, res) => {
  const marca = normalizeMarca(req.query.marca);
  if (!marca) return res.status(400).json({ error: "Informe ?marca=PPXXX" });

  try {
    const html = await fetchRabHtml(marca);
    const parsed = parseRabHtml(html);

    if (parsed.maybeNotFound && Object.keys(parsed.fields).length === 0) {
      return res.status(404).json({ error: "Matrícula não encontrada", marca });
    }

    return res.json({
      marca,
      fonte: ANAC_RAB_URL,
      consultado_em: new Date().toISOString(),
      ...parsed,
    });
  } catch (err) {
    return res.status(502).json({
      error: "Falha consultando a ANAC",
      details: String(err?.message || err),
    });
  }
});

app.get("/api/aeronave.xlsx", async (req, res) => {
  const marca = normalizeMarca(req.query.marca);
  if (!marca) return res.status(400).send("Informe ?marca=PPXXX");

  try {
    // Reusa o mesmo fluxo do HTML (cache já ajuda)
    const html = await fetchRabHtml(marca);
    const parsed = parseRabHtml(html);

    if (parsed.maybeNotFound && Object.keys(parsed.fields).length === 0) {
      return res.status(404).send("Matrícula não encontrada");
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = "Consulta RAB (ANAC)";
    wb.created = new Date();

    // Aba 1: campos
    const ws = wb.addWorksheet("Aeronave");
    ws.columns = [
      { header: "Campo", key: "campo", width: 35 },
      { header: "Valor", key: "valor", width: 70 },
    ];
    ws.getRow(1).font = { bold: true };

    for (const [campo, valor] of Object.entries(parsed.fields || {})) {
      ws.addRow({ campo, valor });
    }

    ws.addRow({});
    ws.addRow({ campo: "Matrícula consultada", valor: marca });
    ws.addRow({ campo: "Fonte", valor: ANAC_RAB_URL });
    ws.addRow({ campo: "Consultado em (UTC)", valor: new Date().toISOString() });

    // Aba 2: links (se tiver)
    const ws2 = wb.addWorksheet("Links");
    ws2.columns = [
      { header: "Texto", key: "text", width: 55 },
      { header: "URL", key: "href", width: 90 },
    ];
    ws2.getRow(1).font = { bold: true };
    (parsed.links || []).forEach((l) => ws2.addRow(l));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${toSafeFilename(`aeronave_${marca}`)}.xlsx"`
    );

    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    return res.status(502).send(`Falha gerando Excel: ${String(err?.message || err)}`);
  }
});

// Healthcheck para deploy
app.get("/health", (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Rodando em http://localhost:${PORT}`);
});
