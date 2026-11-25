# QuestFlow — Smart Scheduling for Campus Staff

**Live demo:** https://questflow-946172759739.northamerica-northeast2.run.app

Built in the Google × UWaterloo Futures Lab (2026).

## The problem

On a large campus, staff often have back-to-back meetings in different buildings. Their calendar shows them as "free" right up until the next meeting, so colleagues book them into slots they can't physically reach, and they arrive late. They also have to work out on their own when to leave.

## What QuestFlow does

- **Calculates walking time** between buildings (including floors and a buffer) using the Google Maps API
- **Flags meetings you'll be late to** and tells you exactly when to leave
- **Maps each day's route** across campus, with late legs highlighted
- **Suggests meeting times** attendees can actually make, based on travel between locations
- **Drafts reschedule requests** for clashes using Gemini
- **Calendar sync** Google Calendar 
- **AI assistant** that answers questions like "Will I be late to any meetings today?"


## Tech stack

- **App:** TypeScript, Vite, Node server (`server.ts`)
- **AI:** Gemini API
- **APIs:** Google Maps API,  Google Calendar API 
- **Deployment:** Docker, Google Cloud Run

## Run it locally

1. Install dependencies:
   ```bash
   npm install --legacy-peer-deps
   ```
2. Start the development server:
   ```bash
   npm run dev
   ```
3. Open http://localhost:3000 in your browser.

> **Note:** Setting `GEMINI_API_KEY` in `.env` is optional. Without it, message drafts use built-in templates. See `.env.example` for all variables, including `VITE_GOOGLE_MAPS_API_KEY` for the campus map and walking routes.

## What I learned

Early feedback from Googlers in the program was that travel-aware scheduling was novel, but that people won't switch to a new calendar app. The next step is to bring these features into the calendar staff already use, as a browser extension for Google Calendar.
