#!/bin/bash
# Roda o frontend Vite no WSL — acessível em localhost:3010 no Windows via WSL2 port forwarding

export TENANT_PACKAGE_DIR=/mnt/d/OpenBot/examples/fintech

BUN=/root/.bun/bin/bun
ROOT=/mnt/d/OpenBot

echo "=== Iniciando frontend (Vite) na porta 3010 ==="
cd $ROOT/app

# Instala dependências se necessário
$BUN install --frozen-lockfile 2>/dev/null || true

$BUN run dev 2>&1
