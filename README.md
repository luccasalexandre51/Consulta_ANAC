# Consulta RAB (ANAC) por matrícula + exportação Excel

Este projeto sobe uma página web simples para consultar uma aeronave no **RAB/ANAC** pela **matrícula** (ex.: `PPXDC`) e exportar os dados para **Excel (.xlsx)**.

## Requisitos
- Node.js 18+ (recomendado 20+)

## Rodar localmente
```bash
npm install
npm start
```

Abra: http://localhost:3000

## Endpoints
- `GET /api/aeronave?marca=PPXXX` → retorna JSON com os campos (parser do HTML)
- `GET /api/aeronave.xlsx?marca=PPXXX` → baixa um Excel com os campos
- `GET /health` → healthcheck simples

## Configuração por variáveis de ambiente (opcional)
- `PORT` (padrão: `3000`)
- `ANAC_RAB_URL` (padrão: `https://aeronaves.anac.gov.br/aeronaves/cons_rab_resposta.asp`)
- `CACHE_TTL_MS` (padrão: `3600000` = 1h)
- `RATE_LIMIT_WINDOW_MS` (padrão: `60000`)
- `RATE_LIMIT_MAX` (padrão: `60`)

## Deploy (Docker)
### Build e run
```bash
docker build -t anac-rab-consulta .
docker run -p 3000:3000 --rm anac-rab-consulta
```

### docker-compose
```bash
docker compose up --build
```

## Observações importantes
- O backend existe para evitar problemas de **CORS** no browser e para tratar encoding do HTML.
- O parser lê tabelas do HTML; se a ANAC mudar o layout, pode exigir ajustes.
- Há cache + rate limit básico para reduzir carga no site da ANAC.
