
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
//File transfer
const multer = require('multer');
//const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
// 1. Cloudinary Configuration (Ensure these match your .env file)
const cloudinary = require("./config/cloudinary");
const APP_BASE_URL = process.env.APP_BASE_URL;

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

//MyTest
const crypto = require("crypto");

const invitationSchema = new mongoose.Schema({
  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  phone: {
    type: String,
    required: true,
    trim: true,
    maxlength: 30
  },
  tokenHash: {
    type: String,
    required: true,
    unique: true
  },
  expiresAt: {
    type: Date,
    required: true,
    index: { expires: 0 }
  }
}, { timestamps: true });

const Invitation = mongoose.model(
  "Invitation",
  invitationSchema
);

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
//MyTest
app.post("/api/invitations", requireLogin, async (req, res, next) => {
  try {
    if (!APP_BASE_URL) {
      return res.status(500).json({
        error: "APP_BASE_URL is not configured"
      });
    }

    const userId = req.session.user.id;
    const phone = String(req.body?.phone || "").trim();

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(401).json({
        error: "Please log in again"
      });
    }

    if (!/^\+?[0-9().\-\s]{7,25}$/.test(phone)) {
      return res.status(400).json({
        error: "Invalid phone number"
      });
    }

    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    );

    await Invitation.create({
      invitedBy: userId,
      phone,
      tokenHash,
      expiresAt
    });

    const inviteUrl =
      `${APP_BASE_URL.replace(/\/+$/, "")}/invite/${token}`;

    res.status(201).json({
      success: true,
      inviteUrl,
      expiresAt
    });
  } catch (err) {
    next(err);
  }
});
const path = require("path");
// Public web page opened from an SMS invitation
app.get("/invite/:token", (req, res) => {
  res.sendFile(
    path.join(__dirname, "public", "invite.html")
  );
});
// Validate a public invitation link
app.get("/api/invitations/:token", async (req, res, next) => {
  try {
    const token = req.params.token;

    if (!/^[a-f0-9]{64}$/i.test(token)) {
      return res.status(400).json({
        valid: false,
        error: "Invalid invitation link"
      });
    }

    const tokenHash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    const invitation = await Invitation.findOne({
      tokenHash,
      expiresAt: { $gt: new Date() }
    }).lean();

    if (!invitation) {
      return res.status(404).json({
        valid: false,
        error: "This invitation has expired or is invalid."
      });
    }

    const inviter = await User.findById(invitation.invitedBy)
      .select("username")
      .lean();

    return res.json({
      valid: true,
      inviterUsername: inviter?.username || null
    });
  } catch (err) {
    next(err);
  }
});

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
	//TEMP END------>
  } catch (err) {
    next(err);
  }
});

// Log in
app.post("/api/login", async (req, res, next) => {
  try {
	console.log("LOGIN ROUTE HIT");
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
        if (saveErr) {
			console.error("SESSION SAVE FAILED:", saveErr);
			return next(saveErr);
		}
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
  const req = socket.request;
  const user = req.session?.user;

  if (!user?.id || !user?.username) {
    return next(new Error("Authentication required"));
  }

  socket.data.user = user;
  next();
});
//TEMp END-------------->
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
     serverSelectionTimeoutMS : 15000,
    });

    console.log("MongoDB connected successfully");
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

//File transfer
// 2. Setup Multer Storage for Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: async (req, file) => {
    // Automatically determine resource type (image, video, or raw file like PDF/docs)
    let resource_type = 'auto'; 
    
    return {
      folder: 'chat_uploads', // Folder name in your Cloudinary media library
      resource_type: resource_type,
      public_id: Date.now() + '-' + file.originalname.replace(/[^a-zA-Z0-9.]/g, "_")
    };
  },
});

const upload = multer({ storage: storage });

// Added below code and comented above to test error
app.post('/api/upload', requireLogin, (req, res) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      console.error('Multer/Cloudinary upload error:', err);

      return res.status(500).json({
        success: false,
        error: err.message || 'Upload middleware failed'
      });
    }

    (async () => {
      try {
        if (!req.file) {
          return res.status(400).json({
            success: false,
            error: 'No file uploaded'
          });
        }

        console.log('Cloudinary upload successful:');

        return res.json({
          success: true,
          fileUrl: req.file.path,
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
          publicId: req.file.filename
        });
      } catch (error) {
        console.error('Upload route error:', error);

        return res.status(500).json({
          success: false,
          error: 'Upload failed'
        });
      }
    })();
  });
});

// 4. Retrive file 
app.get(
  '/api/files/:fileId',
  requireLogin,
  async (req, res) => {
    try {
      const file = await File.findById(req.params.fileId);

      if (!file) {
        return res.status(404).json({
          error: 'File not found'
        });
      }

      // Replace this with your actual conversation membership check.
      const conversation = await Conversation.findOne({
        _id: file.conversationId,
        participants: req.session.user._id
      });

      if (!conversation) {
        return res.status(403).json({
          error: 'You are not allowed to access this file'
        });
      }

      // Return the file only after authorization.
      res.json({
        success: true,
        fileName: file.fileName,
        fileType: file.fileType,
        publicId: file.publicId
      });
    } catch (error) {
      res.status(500).json({
        error: 'Unable to retrieve file'
      });
    }
  }
);