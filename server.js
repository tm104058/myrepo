
require("dotenv").config();

const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const session = require("express-session");
//const MongoStore = require("connect-mongo");
const bcrypt = require("bcrypt");
const { Server } = require("socket.io");
const MongoStoreModule = require("connect-mongo");
const MongoStore = MongoStoreModule.default || MongoStoreModule;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  transports: ["polling", "websocket"]
});
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.MONGODB_URI || !process.env.SESSION_SECRET) {
  throw new Error("MONGODB_URI and SESSION_SECRET are required");
}

if (isProduction) {
  app.set("trust proxy", 1);
}

app.use(express.json({ limit: "10kb" }));
app.use(express.static("public"));

// User account model
const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    lowercase: true,
    minlength: 3,
    maxlength: 24,
    match: /^[a-z0-9_]+$/
  },
  passwordHash: {
    type: String,
    required: true
  }
}, { timestamps: true });

const User = mongoose.model("User", userSchema);

// Persistent MongoDB session store
const sessionMiddleware = session({
  name: "chatapp.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: process.env.MONGODB_URI,
    collectionName: "sessions",
    ttl: 7 * 24 * 60 * 60
  }),
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
});

app.use(sessionMiddleware);

// Share the Express session with Socket.IO.
// Requires Socket.IO 4.6 or later.
io.engine.use(sessionMiddleware);

function requireLogin(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({
      error: "Please log in"
    });
  }
  next();
}

function validUsername(username) {
  return typeof username === "string" &&
    /^[a-zA-Z0-9_]{3,24}$/.test(username);
}

function validPassword(password) {
  return typeof password === "string" &&
    password.length >= 8 &&
    Buffer.byteLength(password, "utf8") <= 72;
}

// Create account and log the user in
app.post("/api/register", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (!validUsername(username)) {
      return res.status(400).json({
        error: "Username must be 3-24 letters, numbers, or underscores"
      });
    }

    if (!validPassword(password)) {
      return res.status(400).json({
        error: "Password must be at least 8 characters"
      });
    }

    const normalizedUsername = username.toLowerCase();

    const existing = await User.findOne({
      username: normalizedUsername
    });

    if (existing) {
      return res.status(409).json({
        error: "Username is already taken"
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    let user;

    try {
      user = await User.create({
        username: normalizedUsername,
        passwordHash
      });
    } catch (err) {
      // The unique database index handles concurrent registrations.
      if (err.code === 11000) {
        return res.status(409).json({
          error: "Username is already taken"
        });
      }
      throw err;
    }

    req.session.regenerate((err) => {
      if (err) return next(err);

      req.session.user = {
        id: user._id.toString(),
        username: user.username
      };

      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);

        res.status(201).json({
          username: user.username
        });
      });
    });
  } catch (err) {
    next(err);
  }
});

// Log in
app.post("/api/login", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.length > 24 ||
      password.length > 72
    ) {
      return res.status(400).json({
        error: "Invalid username or password"
      });
    }

    const user = await User.findOne({
      username: username.toLowerCase()
    });

    if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
      return res.status(401).json({
        error: "Invalid username or password"
      });
    }

    req.session.regenerate((err) => {
      if (err) return next(err);

      req.session.user = {
        id: user._id.toString(),
        username: user.username
      };

      req.session.save((saveErr) => {
        if (saveErr) return next(saveErr);

        res.json({
          username: user.username
        });
      });
    });
  } catch (err) {
    next(err);
  }
});

// Restore login after a page/app restart
app.get("/api/me", requireLogin, (req, res) => {
  res.json({
    username: req.session.user.username
  });
});

// Log out and invalidate the session
app.post("/api/logout", requireLogin, (req, res, next) => {
  const sessionId = req.sessionID;

  req.session.destroy((err) => {
    if (err) return next(err);

    res.clearCookie("chatapp.sid", {
      httpOnly: true,
      secure: isProduction,
      sameSite: "lax",
      path: "/"
    });

    // Disconnect sockets using the revoked session.
    for (const socket of io.sockets.sockets.values()) {
      if (socket.request.sessionID === sessionId) {
        socket.disconnect(true);
      }
    }

    res.json({ ok: true });
  });
});

// Authenticate every new Socket.IO connection
io.use((socket, next) => {
  const user = socket.request.session?.user;

  if (!user?.id || !user?.username) {
    return next(new Error("Authentication required"));
  }

  socket.data.user = user;
  next();
});

io.on("connection", (socket) => {
  console.log("Authenticated user connected:", socket.data.user.username);

  socket.on("chat message", (message) => {
    if (typeof message !== "string") return;

    const text = message.trim();

    if (!text || text.length > 2000) return;

    // Never trust a username supplied by the client.
    io.emit("chat message", {
      username: socket.data.user.username,
      text
    });
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.data.user.username);
  });
});

// Generic error handler; don't expose internal details to clients.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);

  res.status(500).json({
    error: "Server error"
  });
});

async function start() {
	try {
  await mongoose.connect(process.env.MONGODB_URI, {
      : 15000,
    });

    console.log("MongoDB connected successfully");
    await mongoose.disconnect();
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    process.exitCode = 1;
  }

  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Server startup failed:", err.message);
  process.exit(1);
});
