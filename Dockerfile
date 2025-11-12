FROM nodered/node-red:latest

# Arbeitsverzeichnis setzen
USER root

# Arbeitsverzeichnis für das Modul erstellen
WORKDIR /data

# Node-RED Benutzer die Rechte geben
RUN chown -R node-red:root /data && \
    chmod -R 755 /data

# Zurück zu node-red Benutzer wechseln
USER node-red

# Das Modul installieren (für Entwicklung)
WORKDIR /usr/src/node-red
RUN npm install --save /data

# Zurück zum Datenverzeichnis
WORKDIR /data

