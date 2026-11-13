# 🌊 Tide Calendar

**Your Appointments — Your Data.**

A privacy-first, local-first calendar for Windows, Linux, and Android, with direct peer-to-peer synchronization between your own devices.

No cloud. No hosted server. No account required. Just your calendar, your devices, and your data.

---

## About Tide

Tide started with a simple frustration:

**Why is it so difficult to have a private calendar across your own devices without running someone else's infrastructure?**

Most modern calendar applications assume that your data belongs in a cloud service. Alternatives often require maintaining a server, paying for a subscription, or settling for software that hasn't kept up with modern platforms and user expectations.

Tide is an attempt to build something different.

I'm an IT administrator, not a professional software developer. I started this project because I wanted a calendar that worked the way I thought it should: local, private, available across my devices, and capable of synchronizing without depending on a server somewhere on the Internet.

There's also a second motivation behind the project: **curiosity.**

Modern AI coding tools have become surprisingly capable. Tide is partly an experiment to see whether an experienced IT administrator, working alongside AI, can take a reasonably complex piece of software from an idea to a working, secure, and maintainable application.

AI plays a significant role in the development process, assisting with research, architecture, implementation, debugging, testing, and documentation. However, the project still requires human direction, engineering decisions, testing, and accountability.

Whether AI can genuinely help build something like Tide — rather than merely generate impressive-looking code — is something I intend to find out.

The goal remains simple:

> **Build a calendar that belongs to its users, and see how far we can take it.**

---

## Your Calendar. Your Devices. Your Data.

Tide is a **privacy-first personal calendar for Windows, Linux, and Android**.

Every device maintains its own local copy of your calendar. The long-term goal is to let trusted devices discover each other on the local network and synchronize directly, without relying on a central service.

- No cloud account.
- No hosted server.
- No subscription required.
- No mandatory Internet connection.
- No central device that owns your data.

Your devices communicate directly. Your data stays yours.

### Architecture at a glance

```text
                  Local Network
                       |
                 Device Discovery
                       |
          +------------+------------+
          |            |            |
       Windows        Linux       Android
       Local DB      Local DB      Local DB
          |            |            |
          +------------+------------+
                       |
                 Secure P2P Sync
                    (v0.2.0)
```

---

## Platforms

| Platform | Status |
|---|---|
| 🐧 Linux | **0.1.1 Released** |
| 🪟 Windows | Build available — active development |
| 🤖 Android | Development in progress |

The Linux client is currently the most mature implementation and is available in version **0.1.1**.

The Windows client has a working build and is currently receiving further development and refinement.

Android remains under active development, with platform-specific frontend and integration work still underway.

---

## Project Status

**Actively developed — first release available.**

Tide has moved beyond the initial proof-of-concept stage. The first Linux release is available, the Windows client has a working build, and development is progressing toward the next major milestone.

The current development cycle focuses on:

- Refining the Windows client.
- Preparing the Linux client for further releases.
- Continuing Android development.
- Implementing and validating peer-to-peer synchronization.
- Improving calendar interoperability.

### Release milestones

| Version | Focus | Status |
|---|---|---|
| 0.1.1 | Standalone calendar functionality | Released |
| 0.2.0 | Peer-to-peer synchronization | In development |

Tide is still evolving. While the first release is available, the project as a whole should not yet be considered production-ready.

---

## Features

### Available in 0.1.1

**Calendar functionality**

- Month, week, and day views.
- Create, edit, and delete events.
- All-day events.
- Event descriptions.
- Recurring events.
- Event notifications and reminders.
- Offline-first operation.
- Local SQLite storage.

**Interoperability**

- `.ics` calendar import.
- `.ics` calendar export.

### Coming in 0.2.0

**Peer-to-peer synchronization**

- Direct device-to-device synchronization.
- Automatic local network device discovery.
- Bidirectional synchronization.
- Device pairing and authentication.
- Secure device-to-device communication.
- Offline changes and subsequent reconciliation.
- No cloud or central synchronization server.

Synchronization is currently undergoing active debugging and reliability testing ahead of its 0.2.0 release.

---

## Privacy & Synchronization

Tide is built around one simple principle:

> **Your calendar should belong to you.**

Each device stores its own local copy of your calendar. With the introduction of peer-to-peer synchronization in 0.2.0, trusted devices will be able to discover each other on the local network using **mDNS** and establish secure connections.

### How synchronization works

```text
          Local Network
                |
           mDNS Discovery
                |
       +--------+--------+
       |                 |
    Windows             Linux
    Local DB           Local DB
       |                 |
       +-----------------+
                |
          Secure Sync
             v0.2.0
```

**mDNS is used for discovery, not trust.**

Seeing a Tide device on the network does not grant it access to your calendar. Devices must first be paired and authenticated before synchronization is permitted.

Changes made while offline remain on the local device. When paired devices become available again, Tide exchanges changes and reconciles the two calendars.

There is no permanent master device. Each device owns its own copy and can make changes independently.

Your calendar data is stored locally and transmitted directly between trusted devices whenever synchronization is required.

---

## Technology

Tide uses a small number of technologies, each with a specific responsibility:

- **TypeScript** — The main application and user interface. Handles calendar views, event editing, navigation, and other user-facing functionality.
- **Tauri** — Provides the application shell and bridges the TypeScript frontend with native functionality.
- **Rust** — Handles native functionality, including local data storage, networking, device discovery, synchronization, and security-sensitive operations.
- **SQLite** — Provides the local database on each device. Calendar data, events, recurrence information, and synchronization state are stored locally instead of on a central server.

The goal is to share as much application logic as practical across Windows, Linux, and Android while using platform-specific functionality where necessary.

---

## Roadmap

Development is currently focused on completing and refining the existing clients rather than expanding the feature set indiscriminately.

| Feature | Status |
|---|---|
| Linux calendar client | 0.1.1 Released |
| Windows calendar client | Active development |
| Android client | In development |
| Local SQLite storage | Implemented |
| Calendar event management | Implemented |
| Recurring events | Implemented |
| Notifications and reminders | Implemented |
| `.ics` import/export | Implemented |
| Local network discovery | Implemented |
| Peer-to-peer synchronization | Target: 0.2.0 |
| Device pairing and authentication | Target: 0.2.0 |
| Multi-language support | Planned |
| Multiple calendars / categories | Planned |
| Themes and customizable color palettes | Planned |

---

## Security

Please **do not report security vulnerabilities through public GitHub issues**.

Use GitHub's private vulnerability reporting where available.

See [`SECURITY.md`](SECURITY.md) for the vulnerability disclosure policy.

Additional architecture and security documentation can be found in [`docs/`](docs/).

---

## License

### Tide's Licensing Philosophy

Tide is **source-available and non-commercial**.

The source is available for anyone to read, study, modify, and use for personal, educational, experimental, hobbyist, qualifying nonprofit, academic, or governmental purposes.

Tide is **not Open Source in the OSI sense**. Commercial use is intentionally restricted.

If you're a company, freelancer, consultant, or anyone else looking to use Tide as part of a commercial product, service, or business, that's absolutely something we can talk about. Commercial licensing is available by agreement.

The idea is simple: Tide should remain freely available to individuals and communities, while commercial users who get real business value from it can help support the project financially.

This section explains the philosophy behind the licensing model. The license itself is the authoritative document governing permitted use.

I'm not trying to build a licensing maze. I just don't want large commercial interests getting a free ride on something that's meant to stay accessible to people and communities.

**Commercial licensing inquiries:**

[skins@uplink-incorporated.net](mailto:skins@uplink-incorporated.net)

---

## AI-Assisted Development

Tide is developed with significant assistance from AI tools, including **GLM-5.3-Flash** and **Claude**.

AI is used for research, architecture, implementation, debugging, testing, and documentation.

AI-generated work is reviewed, tested, and modified as part of the development process. The project lead remains responsible for the project's direction, decisions, and final result.

AI tools can make mistakes. The source code, tests, documentation, and actual behavior of the software should therefore be considered the authoritative representation of the project — not the fact that AI was involved in producing it.

---

**Tide Calendar — Your Appointments. Your Devices. Your Data.**
