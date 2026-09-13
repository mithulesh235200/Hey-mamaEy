# Space Connect

Space Connect is a privacy-first web application designed for private, anonymous group messaging and media sharing without requiring phone numbers or email addresses.

## Features

### 1. Anonymous Identity System
- **Zero-Credential Onboarding**: Generate a unique identity code (e.g., `MAMA-8392-EY71`) automatically upon first launch.
- **Identity Portability**: Easily copy or restore your unique identity token on any browser or device.

### 2. Private Spaces & Group Access
- **Instant Space Creation**: Create a private messaging space in one click.
- **Passcode Joining**: Join spaces instantly using custom 8-digit or 6-digit space codes.

### 3. Multi-Media Messaging Engine
- **Text & Formatting**: Markdown and rich emoji support.
- **Images**: High-resolution inline previews with full-screen lightbox modal.
- **Videos**: Built-in video player with controls.
- **Voice & Audio Notes**: Audio waveform player with inline play/pause controls.
- **Documents & Files**: Custom attachment cards supporting `.pdf`, `.docx`, `.zip`, and general file downloads.

### 4. Direct Forwarding
- Instantly forward any text or media message to any connected space with a single click.

## Local Setup

### Prerequisites
- Node.js (v18+)
- npm or bun

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/space-connect.git
cd space-connect

# Install dependencies
npm install

# Start local dev server
npm run dev
```

### Build & Deployment

```bash
# Production build
npm run build

# Preview build locally
npm run preview
```

Deployable to Vercel or any standard Node/Static web host.
