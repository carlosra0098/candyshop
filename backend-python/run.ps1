# Arranca el backend CandyShop en FastAPI (Python)
#   .\run.ps1          → puerto 8000 (por defecto)
#   .\run.ps1 -Port 3000 → puerto 3000 (requiere detener la versión Node previa)
param([int]$Port = 8000)

$env:PORT = $Port
Set-Location $PSScriptRoot
& .\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port $Port
