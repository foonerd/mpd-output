# MPD HTTP & Icecast output

A Volumio 4 plugin that streams what the player is playing: as an HTTP stream served from the player, to an Icecast server, or both.

Store name: `mpdoutput` (category `audio_interface`). Existing installations upgrade in place and keep their settings.

## What it does

- **HTTP stream** — MPD serves the encoded audio on a port of your choice. Any player on the network opens `http://<player>:<port>/`. Encoders: MP3, Ogg Vorbis, Ogg Opus, FLAC.
- **Icecast** — the encoded audio is published on a mount of an Icecast 2 server. Encoders: Ogg Vorbis, Ogg Opus, MP3. Track titles reach the server for Vorbis (in-band) and MP3 (through Icecast's metadata interface). Icecast 2.4 does not expose titles for Opus mounts; listeners still receive the audio.

Both streams follow playback, pause and stop. While stopped, listeners stay connected and hear silence.

## How the Icecast stream stays up

MPD does not talk to the Icecast server. MPD hands the encoded stream to a small relay on the player (`relay/relay.js`, a systemd service `mpd-output-relay.service`), and the relay publishes it. The relay owns every network timeout:

- if the server reboots, is restarted or refuses the connection, the relay reconnects with increasing intervals (1 s up to 30 s);
- if the server or the network freezes without closing the connection, the relay notices within seconds that nothing is being accepted, drops the connection and reconnects;
- if the credentials are rejected, it waits a minute between attempts;
- if MPD restarts (Volumio does that when the output device changes), the relay re-attaches to the feed as soon as playback resumes.

Playback on the player is never affected by any of this: MPD's side of the feed is non-blocking by design and discards what the relay cannot take. The **Show relay status** button in the settings reports whether the relay is connected to MPD and to the server and the last error, if any.

## Settings

**HTTP stream**: on/off, stream name, encoder, bitrate, sample format, port. Advanced: maximum number of listeners, genre and website announced to players.

**Icecast**: on/off, server, port, mount point, source user and password, encoder, bitrate, sample format, stream name, public listing. Advanced: description, genre, website, and the local feed port (127.0.0.1:8010 by default; change only if another service uses it).

Saving restarts MPD; playback resumes from the current track.

## Where things live on the player

| What | Where |
| --- | --- |
| Plugin | `/data/plugins/audio_interface/mpdoutput/` |
| Settings | `/data/configuration/audio_interface/mpdoutput/config.json` |
| Relay settings (written by the plugin, contains the source password, mode 0600) | `/data/configuration/audio_interface/mpdoutput/relay.json` |
| Relay service | `mpd-output-relay.service`, log: `journalctl -u mpd-output-relay` |
| Relay status | `/run/mpd-output/status.json` |
| MPD outputs | added to Volumio's generated `/etc/mpd.conf` under the comment `# mpdoutput plugin: streaming outputs`; written by Volumio, not by the plugin |

The MPD outputs are contributed through Volumio's own MPD configuration writer, so they survive output-device and playback-option changes and disappear when the plugin is disabled or uninstalled.

## Requirements

Volumio 4 (bookworm) with MPD built with the `httpd` output plugin (every Volumio 4 image qualifies). Icecast 2.4 or later for the Icecast stream; the SHOUTcast and Icecast 1 source protocols are not supported.

## Development

```
npm test               # syntax check of index.js and relay/relay.js
```

The relay can be run standalone for diagnosis:

```
node relay/relay.js /data/configuration/audio_interface/mpdoutput/relay.json --status /tmp/status.json
```

## Credits

Original plugin by Balbuze. Rework (relay, configuration integration, validation, translations) by Just a Nerd.

## License

ISC
