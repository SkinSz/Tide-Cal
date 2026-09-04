# Tide Calendar

A privacy-first, local calendar with peer-to-peer synchronization.

**Your Appointments — Your Data.**

No cloud or server. No account required. Built for people who want their calendar to remain theirs.

## About Tide

Tide started with a simple frustration: **why is it so difficult to have a private calendar across your own devices without running someone else's infrastructure?**

Most modern calendar applications assume that your data belongs in a cloud service. The alternatives often require running a server, subscribing to an existing service, or using software that hasn't kept up with modern platforms and user expectations.

Tide is an attempt to build a different option.

I'm an IT administrator, not a professional software developer. I started this project because I wanted a calendar that worked the way I thought it should: local, private, available across my devices, and capable of synchronizing without depending on a server somewhere on the Internet.

There's also a second motivation behind the project: **curiosity.**

Modern AI coding tools have become surprisingly capable. Tide is partly an experiment to see whether an experienced IT administrator, working alongside AI, can actually take a reasonably complex piece of software from an idea to a working, secure, maintainable application.

AI is therefore a significant part of the development process. It helps with research, architecture, implementation, debugging, testing, and documentation. But the project still requires human direction, decisions, testing, and accountability.

Whether AI can genuinely help build something like Tide — rather than merely generate impressive-looking code — is something I intend to find out.

The goal remains simple:

> **Build a calendar that belongs to its users, and see how far we can take it.**

## Your Calendar. Your Devices. Your Data.

Tide is a **privacy-first personal calendar for Windows, Android, and Linux**.

Each device keeps its own local copy of your calendar. When trusted devices are connected to the same local network, Tide discovers them and synchronizes directly between them.

No cloud account.
No hosted server.
No subscription required.
No mandatory Internet connection.

```text
                 Local Network
                      │
       ┌──────────────┼──────────────┐
       │              │              │
    Windows          Linux        Android
    Local DB        Local DB       Local DB
       │              │              │
       └──────────────┼──────────────┘
                    Sync
```

## Platforms

| Platform   | Status                 |
| ---------- | ---------------------- |
| 🪟 Windows | 🚧 Development         |
| 🐧 Linux   | Released 0.1.0         |
| 🤖 Android | 🚧 Development         |

## Project Status

🚧 **Early development**

The project is currently focused on building a usable calendar client across all three platforms, followed by reliable peer-to-peer synchronization.

The Linux client is currently the most mature and is approaching release readiness. 

Tide as a whole is still under active development and should not yet be considered production-ready.

## Current Release Features

* Month, week, and day views
* Create, edit, and delete events
* All-day events
* Event descriptions
* Event recurrence
* Event notifications / reminders
* Offline-first operation
* Bidirectional device synchronization
* Local network synchronization
* No cloud dependency

## Planned Features 🚧 WIP

* `.ics` import and export
* Multiple calendars/categories
* Multi-Language Support (Currently English)
* Windows Port
* Android Port and Frontend Rewrite
* Support for Themes or different colour palletes

## Privacy & Synchronization

Tide is built around a simple principle:

> **Your calendar should belong to you.**

Each device stores its own local copy of your calendar. When trusted devices are connected to the same local network, Tide uses **mDNS** to discover them and establishes a secure connection between paired devices.

```text
        Local Network
             │
       mDNS Discovery
             │
     ┌───────┴───────┐
     │               │
   Windows          Android
   Local DB         Local DB
     │               │
     └─── Secure ────┘
           Sync
```

**mDNS is used for discovery, not trust.**

Seeing a Tide device on the network does not give it access to your calendar. Devices must first be paired and authenticated before synchronization is permitted.

Changes made while offline remain on the local device. When paired devices become available again, Tide exchanges changes and reconciles the two calendars.

There is no permanent master device. Each device owns its own copy and can make changes independently.

Your calendar data is stored locally and is transmitted directly between trusted devices when synchronization is required.

## Technology

Tide uses a small number of technologies, each with a specific role:

* **TypeScript** — The main application and user interface. Handles the calendar UI, views, event editing, navigation, and other user-facing functionality.

* **Tauri** — Provides the application shell and connects the TypeScript frontend with native functionality.

* **Rust** — Handles native functionality including local data storage, networking, device discovery, synchronization, and security-sensitive operations.

* **SQLite** — Provides the local database on each device. Calendar data, events, recurrence information, and synchronization state are stored locally rather than on a central server.

The goal is to share as much application logic as practical across Windows, Linux, and Android while using platform-specific functionality where necessary.

## Security

Please **do not report security vulnerabilities through public GitHub issues**.

Use GitHub's private vulnerability reporting where available.

See [`SECURITY.md`](SECURITY.md) for the vulnerability disclosure policy.

Additional architecture and security documentation can be found in [`docs/`](docs/).

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

## AI-Assisted Development

Tide is developed with significant assistance from AI tools, including **GLM-5.3-Flash**.

AI is used for research, architecture, implementation, debugging, testing, and documentation.

AI-generated work is reviewed, tested, and modified as part of the development process. The project lead remains responsible for the project's direction, decisions, and final result.

AI tools can make mistakes. The source code, tests, documentation, and actual behavior of the software should therefore be considered the authoritative representation of the project — not the fact that AI was involved in producing it.
