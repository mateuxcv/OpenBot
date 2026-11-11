#!/bin/bash
# Sobe o servidor OpenBot no WSL.
# Configure as variáveis de ambiente antes de rodar:
#   export AWS_REGION=us-east-1
#   export AWS_ACCESS_KEY_ID=...
#   export AWS_SECRET_ACCESS_KEY=...

set -e

export TENANT_PACKAGE_DIR=/mnt/d/OpenBot/examples/fintech

BUN=/root/.bun/bin/bun
ROOT=/mnt/d/OpenBot

echo "=== Parando processos anteriores ==="
pkill -f 'bun.*index.ts' 2>/dev/null || true
sleep 1

echo "=== Iniciando PostgreSQL ==="
sudo service postgresql start 2>&1 | tail -1
sleep 2

echo "=== Verificando banco ==="
psql "postgres://openbot:openbot@127.0.0.1:5432/openbot" -c "SELECT 1" 2>&1

echo "=== Iniciando servidor na porta 3001 (bind 0.0.0.0) ==="
cd $ROOT
$BUN --env-file=.env run server/src/index.ts > /tmp/openbot-server.log 2>&1 &
SERVER_PID=$!

echo "=== Aguardando servidor ==="
for i in $(seq 1 25); do
  sleep 2
  if curl -s --max-time 1 http://127.0.0.1:3001/health > /dev/null 2>&1; then
    echo "✅ Servidor UP (${i}x2s)"
    break
  fi
  if [ $i -eq 25 ]; then
    echo "❌ Servidor não subiu. Log:"
    tail -20 /tmp/openbot-server.log
    exit 1
  fi
  echo "   aguardando... ${i}/25"
done

WSL_IP=$(hostname -I | awk '{print $1}')
echo ""
echo "================================================"
echo "  ✅ Servidor rodando"
echo "  IP do WSL: $WSL_IP"
echo "  Porta:     3001"
echo "================================================"
echo ""
echo "No Windows, inicie o frontend com:"
echo "  wsl bash /mnt/d/OpenBot/scripts/start-app-wsl.sh"
echo ""
echo "Depois abra: http://localhost:3010"
echo ""
echo "Log do servidor: tail -f /tmp/openbot-server.log"
echo ""

# Mantém vivo
tail -f /tmp/openbot-server.log
