# Herdr-Oberfläche – meine Einstellungen

Dieses Repo enthält meine eigene Herdr-Oberfläche (`~/.config/herdr-app`), damit
alle Rechner gleich aussehen und sich gleich bedienen lassen.

## Was drin ist

| Datei / Ordner | Inhalt |
|---|---|
| `layouts/my-main.json` | mein Layout (Klon von Herdrs `main`) |
| `layouts/.state/my-main.json` | Klicks zum Layout (z. B. Sidebar-Breite) |
| `mods/my-agents/`, `mods/my-menu/`, `mods/my-spaces/`, `mods/space-launcher/` | meine eigenen Mods |
| `keys.json` | Tastenbelegung |
| `settings.json` | Zoom, Sounds, Darstellung |
| `themes/` | Farbschemata |
| `.gitignore` | legt fest, was synchronisiert wird (Whitelist) |

## Was absichtlich NICHT drin ist

Diese Dateien schreibt Herdr auf jedem Rechner selbst. Sie würden sich zwischen
den Rechnern ständig gegenseitig überschreiben:

- `view.json`, `window.json`, `windows.json`, `seen.json`, `installed.json`:
  Fokus, Fenstergröße und Buchhaltung des Rechners
- `shared.json`: aktives Layout, Space-Farben, **Space-Launcher-Presets**.
  Darin stehen rechnerspezifische Space-IDs und Pfade, deshalb muss man sie auf
  jedem Rechner selbst anlegen.
- `data/`: der gespeicherte Zustand der Mods
- `telemetry/`, `update-notes*`, `frame/`, `icons/`
- `*.d.ts`, `jsconfig.json`, `*.error`: werden von Herdr erzeugt
- die mitgelieferten Layouts (`main`, `terminals`, `win98`) und Mods
  (`agents`, `spaces`, `tabs`, …): Herdr ersetzt sie bei jedem Start

Neue eigene Mods sollten mit `my-` anfangen (z. B. `mods/my-foo/`). Dann werden
sie automatisch mitgenommen. Für Mods mit einem anderen Namen braucht es in der
`.gitignore` eine eigene `!/mods/<name>/`-Zeile.

## Auf einem neuen PC einrichten

Voraussetzung: Herdr ist installiert und wurde **einmal gestartet**, damit
`~/.config/herdr-app` mit Herdrs eigenen Dateien existiert.

1. **Herdr beenden** (nicht zwingend nötig, aber dann wird nichts halb geladen).

2. Das Repo in den bestehenden Ordner holen. `git clone` geht nicht, weil der
   Ordner schon voll ist. Deshalb so:

   ```sh
   cd ~/.config/herdr-app
   git init
   git remote add origin git@github.com:flozy/herdr-config.git
   git fetch origin
   git checkout -f -B main origin/main
   ```

   `checkout -f` überschreibt `keys.json` und `settings.json` dieses Rechners.
   Alles andere, also Herdrs eigene Dateien, bleibt unberührt.

3. Git-Identität für Commits setzen (einmal pro Rechner):

   ```sh
   git config user.name  "flozy"
   git config user.email "<deine Mail>"
   ```

4. **Herdr starten und aufs eigene Layout umschalten.** Auf einem neuen
   Rechner zeigt `shared.json` noch auf das Standard-Layout `main`.
   Umschalten geht so:
   - `ctrl-shift-l` drücken, bis „my-main“ erscheint, oder
   - im Terminal: `herdr-app do layout.switch --name my-main`

   Herdr merkt sich das, nach einem Neustart bleibt `my-main` aktiv.

5. Prüfen, ob alles sauber geladen ist:

   ```sh
   herdr-app status          # zeigt Fehler aus Dateien und Mods
   for m in mods/my-* mods/space-launcher; do herdr-app check "$m"; done
   ```

6. Wenn gewünscht, die Space-Launcher-Presets auf diesem Rechner neu anlegen
   (sie liegen in `shared.json` und werden nicht synchronisiert).

## Im Alltag

Änderungen von einem anderen Rechner holen (Herdr übernimmt sie sofort):

```sh
cd ~/.config/herdr-app && git pull
```

Eigene Änderungen teilen:

```sh
cd ~/.config/herdr-app
git add -A
git commit -m "Was geändert wurde"
git push
```

Wegen der Whitelist in `.gitignore` landet bei `git add -A` nur das, was oben
unter „Was drin ist“ steht.

## Wenn etwas kaputt ist

- Bei einer ungültigen Datei behält Herdr die letzte gute Version und schreibt
  den Grund in `<name>.error` (z. B. `keys.error`).
- **Notausgang:** `ctrl-alt-shift-escape` legt das gezeigte Layout und
  `keys.json` beiseite (`*.reset-<zeit>`) und schaltet zurück auf `main`.
- Den Stand aus dem Repo zurückholen: `git checkout -- .`
