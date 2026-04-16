# 1APP Buzzer

A modern, real-time buzzer application for quiz nights, game shows, or classroom activities. Built with Node.js, Express, Socket.io, and Tailwind CSS.

## Features

- **Real-time Interaction:** Instant buzzer response and live emoji reactions.
- **Host Dashboard:** Complete control over the game, including scoring, player management, and game flow.
- **Player Interface:** Mobile-friendly interface with customizable avatars (emojis), haptic feedback (vibration), and dark/light mode.
- **QR Code Integration:** Easy player joining via auto-generated QR codes.
- **Scoring System:** Track points, display a "Hall of Fame" at the end of the game, and see real-time scores on player devices.
- **Automated Mechanics:** Configurable countdowns, auto-unlocking buzzers, and optional point subtraction for wrong answers.
- **Visual & Audio Effects:** Floating emoji reactions, confetti animations, tactile buzzer effects, and a full game show sound system.

## Tech Stack

- **Backend:** Node.js, Express
- **Real-time:** Socket.io
- **Frontend:** EJS (Templating), Tailwind CSS, Canvas-confetti
- **Utilities:** QR Code generation, Dotenv

## Prerequisites

- [Node.js](https://nodejs.org/) (v14 or higher recommended)
- npm (comes with Node.js)

## Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd buzzer
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Setup:**
   Create a `.env` file in the root directory and add the following:
   ```env
   PORT=3000
   HOST_PASSWORD=your_secure_password
   SESSION_SECRET=your_session_secret
   ```

## Running the App

### Development Mode (with CSS watch)
```bash
npm run dev
```

### Production Mode
```bash
npm start
```

Once running, access the application at:
- **Player View:** `http://localhost:3000/player`
- **Host View:** `http://localhost:3000/host` (Login required)

## How to Use

1. **Host Login:** Go to `/host` and log in with the password defined in your `.env` file.
2. **Invite Players:** Share the URL or have players scan the QR code displayed on the host dashboard.
3. **Start the Game:** 
   - Players register with a name and an emoji.
   - Players can send real-time reactions (🔥, 👏, etc.) using the emoji buttons on their interface.
   - The host manages rounds, awards points, and can toggle optional point subtraction in "System Settings".
4. **End Game:** Use the "Spiel Beenden" button to see the final winner and the Hall of Fame.
