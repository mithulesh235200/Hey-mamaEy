# Developer Guidelines - Space Connect

## Overview
Space Connect is a privacy-first, anonymous web application for real-time messaging and media sharing. Users communicate using anonymous IDs and space passcodes without needing phone numbers, email addresses, or passwords.

## Architecture
- **Framework**: React + Vite + TanStack Start / Router
- **Backend & Database**: Supabase (Realtime & Storage)
- **Styling**: Tailwind CSS + Shadcn UI primitives

## Development Workflow
- Follow clean React functional component patterns.
- Ensure all environment variables (`VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`) are properly populated.
- Keep commits clear, descriptive, and modular.
