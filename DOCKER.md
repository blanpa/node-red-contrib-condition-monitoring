# Docker Setup für Entwicklung

Dieses Projekt kann mit Docker Compose für die Entwicklung gestartet werden.

## Voraussetzungen

- Docker
- Docker Compose

## Schnellstart

```bash
# Entwicklungsmodus starten
docker-compose -f docker-compose.dev.yml up --build

# Node-RED öffnen
# http://localhost:1880
```

## Verfügbare Docker Compose Dateien

### docker-compose.dev.yml (Entwicklungsmodus)

**Empfohlen für Entwicklung!**

- Hot-Reload: Änderungen an Nodes werden automatisch erkannt
- Gesamtes Projekt wird als Volume gemountet
- Node-RED erkennt das Modul automatisch

```bash
docker-compose -f docker-compose.dev.yml up --build
```

**Features:**
- ✅ Hot-Reload von Node-Änderungen
- ✅ Kein Neustart nötig nach Code-Änderungen
- ✅ Node-RED Daten werden in `./node-red-data` gespeichert
- ✅ Port 1880 für Node-RED UI

### docker-compose.yml (Produktionsmodus)

Für Tests der finalen Version:

```bash
docker-compose up --build
```

## Verzeichnisstruktur

```
node-red-contrib-condition-monitoring/
├── docker-compose.yml          # Produktionsmodus
├── docker-compose.dev.yml      # Entwicklungsmodus
├── Dockerfile                   # Basis Dockerfile
├── Dockerfile.dev              # Entwicklungs Dockerfile
├── node-red-data/              # Node-RED Daten (wird erstellt)
│   ├── flows.json
│   ├── settings.js
│   └── ...
└── nodes/                      # Ihre Nodes (wird gemountet)
```

## Entwicklungsworkflow

1. **Container starten:**
   ```bash
   docker-compose -f docker-compose.dev.yml up --build
   ```

2. **Node-RED öffnen:**
   - Browser: http://localhost:1880

3. **Nodes entwickeln:**
   - Bearbeiten Sie Dateien in `nodes/`
   - Node-RED erkennt Änderungen automatisch
   - Klicken Sie auf "Deploy" in Node-RED, um Nodes neu zu laden

4. **Logs anzeigen:**
   ```bash
   docker-compose -f docker-compose.dev.yml logs -f
   ```

5. **Container stoppen:**
   ```bash
   docker-compose -f docker-compose.dev.yml down
   ```

## Troubleshooting

### Node-RED erkennt Nodes nicht

1. Prüfen Sie die Logs:
   ```bash
   docker-compose -f docker-compose.dev.yml logs
   ```

2. Stellen Sie sicher, dass `package.json` korrekt ist

3. Container neu starten:
   ```bash
   docker-compose -f docker-compose.dev.yml restart
   ```

### Port bereits belegt

Ändern Sie den Port in `docker-compose.dev.yml`:

```yaml
ports:
  - "1881:1880"  # Statt 1880:1880
```

### Node-RED Daten zurücksetzen

```bash
# Container stoppen
docker-compose -f docker-compose.dev.yml down

# node-red-data Verzeichnis löschen
rm -rf node-red-data/

# Neu starten
docker-compose -f docker-compose.dev.yml up
```

## Abhängigkeiten installieren

Wenn Sie zusätzliche npm-Pakete benötigen:

1. Fügen Sie sie zu `package.json` hinzu
2. Container neu bauen:
   ```bash
   docker-compose -f docker-compose.dev.yml build
   docker-compose -f docker-compose.dev.yml up
   ```

## Produktions-Build

Für einen Produktions-Build:

```bash
docker-compose build
docker-compose up -d
```

## Weitere Informationen

- [Node-RED Docker Hub](https://hub.docker.com/r/nodered/node-red/)
- [Node-RED Dokumentation](https://nodered.org/docs/)

