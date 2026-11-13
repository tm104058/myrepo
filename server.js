
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

//const { CloudinaryStorage } = require('multer-storage-cloudinary');
const storage = multer.memoryStorage();
const upload = multer({
    storage,
    limits: {
        fileSize: 25 * 1024 * 1024 //25 MB
    }
});
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
  },
  role: {
    type: String,
    enum: ["user", "admin"],
    default: "user"
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

const memberSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    role: {
      type: String,
      enum: ["admin", "member"],
      default: "member",
    },

    joinedAt: {
      type: Date,
      default: Date.now,
    },

    lastReadAt: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const groupSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 2,
      maxlength: 50,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    members: {
      type: [memberSchema],
      validate: {
        validator: function (members) {
          const ids = members.map((m) => m.user.toString());
          return ids.length === new Set(ids).size;
        },
        message: "Duplicate group members are not allowed",
      },
    },

    lastMessage: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },

    lastMessageAt: {
      type: Date,
      default: null,
    },

    settings: {
      onlyAdminsCanSend: {
        type: Boolean,
        default: false,
      },

      onlyAdminsCanAddMembers: {
        type: Boolean,
        default: false,
      },
    },

    isActive: {
      type: Boolean,
      default: true,
    },
	recentMessages: [
    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
    },
  ],
  },
  { timestamps: true }
);

// Find groups belonging to a user
groupSchema.index({ "members.user": 1, updatedAt: -1 });

const groupsModel = mongoose.model("Group", groupSchema);



const messageSchema = new mongoose.Schema(
  {
    conversationType: {
      type: String,
      enum: ["private", "group"],
      required: true,
    },

    groupId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Group",
      default: null,
    },

    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    content: {
      type: String,
      default: "",
    },

    messageType: {
      type: String,
      enum: ["text", "image", "video", "audio", "file"],
      default: "text",
    },

    attachments: [
      {
        url: String,
        fileName: String,
        fileSize: Number,
        mimeType: String,
      },
    ],

    readBy: [
      {
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
        },
        readAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    deliveredTo: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
      },
    ],

    replyTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Message",
      default: null,
    },

    isEdited: {
      type: Boolean,
      default: false,
    },

    isDeleted: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// Fetch messages in chronological order efficiently
messageSchema.index({ groupId: 1, createdAt: -1 });

const messageModel = mongoose.model("Message", messageSchema);


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
async function verifyAdmin(req, res, next) {
	try {
		if (!req.session.user) {
			return res.status(401).json({
			  error: "Please log in"
			});
		}
		const user = await User.findById(req.session.user.id).select("-password");
		if (!user) {
		  return res.status(401).json({
			success: false,
			message: "User not found"
		  });
		}
		if (user.role !== "admin") {
		  return res.status(403).json({
			success: false,
			message: "Admin access only"
		  });
		}
		req.user = user;
		next();
	}catch (error) {
    console.error(error);
    res.status(500).json({
      success: false,
      message: "Authorization failed"
    });
  }
  
}
//MyTest
app.post("/api/createGroups", verifyAdmin, async(req, res, next) => {
try{
	const { name, members = [] } = req.body;
	const userId = req.session.user.id;
	
	const uniqueMembers = [...new Set([userId.toString(), ...members.map(String)])];
	const group = await groupsModel.create({
      name,
      createdBy: userId,

      members: uniqueMembers.map((id) => ({
        user: id,
        role:
          id === userId.toString()
            ? "admin"
            : "member",
      })),
	});
	
	res.status(201).json({
      success: true,
	  message: "Room created successfully!",
	  group_id: group._id
    });

}catch(error){
	res.status(500).json({
      success: false,
      message: error.message,
    });
}
});
app.post("/api/sendMessage/:groupId", requireLogin, async(req, res, next) => {
	try{
		const userId = req.session.user.id;
	
		if (!mongoose.isValidObjectId(userId)) {
		  return res.status(401).json({
			error: "Please log in again"
		  });
		}
		const { content, messageType, replyTo, conversationType} = req.body; 
		const { groupId } = req.params;
		const group = await groupsModel.findOne({
			_id: groupId,
			isActive: true,
			"members.user": userId
		});
		if (!group) {
			return res.status(403).json({
			success: false,
			message: "Group not found or access denied"
			});
		}
		const member = group.members.find(
		(m) => m.user.toString() === userId.toString());

		if(member.role != 'admin' && group.settings.onlyAdminsCanSend ){
			return res.status(403).json({
				success: false,
				message: "Only admin can send message"
			});
		}
		const message = await messageModel.create({
			groupId: groupId,
			sender: userId,
			content,
			messageType: messageType || "text",
			replyTo: replyTo || null,
			conversationType: conversationType || "group"
		});
		// Update latest message reference

		// Update group with latest 5 messages
		await groupsModel.findByIdAndUpdate(groupId, {
		  $push: {
			recentMessages: {
			  $each: [message._id],
			  $slice: -5,
			},
		  },
		  $set: {
			lastMessage: message._id,
			lastMessageAt: message.createdAt
		}
		});
		
		
		res.status(201).json({
		success: true,
		message,
		});
	}catch(error){
		res.status(500).json({
		success: false,
		message: error.message,
		});
	}
});
app.get("/api/group/:groupId/getMessages", requireLogin, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const { groupId } = req.params;

        if (!mongoose.isValidObjectId(userId) ||
            !mongoose.isValidObjectId(groupId)) {
            return res.status(400).json({
                success: false,
                message: "Invalid ID"
            });
        }
		
        const group = await groupsModel.findOne({
            _id: groupId,
            isActive: true,
            "members.user": userId
        }).populate({
            path: "recentMessages",
            populate: [
                {
                    path: "sender",
                    select: "username profilePic"
                },
                {
                    path: "replyTo"
                }
            ]
        });

        if (!group) {
            return res.status(403).json({
                success: false,
                message: "Group not found or access denied"
            });
        }

        return res.status(200).json({
            success: true,
            messages: group.recentMessages
        });

    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});
app.get("/api/getMyGroups", requireLogin, async(req, res, next) => {
	const userId = req.session.user.id;
	
    if (!mongoose.isValidObjectId(userId)) {
      return res.status(401).json({
        error: "Please log in again"
      });
    }
	try{
		const groups = await groupsModel.find({
		"members.user" : userId}).select("_id name createdBy members");
		res.status(200).json({
			success: true,
			groups
		});

	}catch(error){
		res.status(500).json({
		success: false,
		message: error.message,
    });
	}
});
app.post("/api/addGroupMembers", verifyAdmin, async(req, res, next) => {
try{
	const { groupId, memberIds = [] } = req.body;
	const userId = req.session.user.id;
	if (!groupId || !Array.isArray(memberIds)) {
            return res.status(400).json({
                success: false,
                message: "Invalid group or member IDs"
            });
        }

	const group = await groupsModel.findById(groupId);
	if (!group) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }
	// Verify that selected users exist
	const validUsers = await User.find({
		_id: { $in: memberIds }
	}).select("_id");
	
	const existingMembers = new Set(
            group.members.map(m => m.user.toString())
        );

	// Add only new members
    const newMembers = validUsers.filter(
            user => !existingMembers.has(user._id.toString())
        );
	newMembers.forEach(user => {
            group.members.push({
                user: user._id,
                role: "member"
            });
        });
	await group.save();

	
	res.status(201).json({
      success: true,
	  message: `${newMembers.length} member(s) added successfully`,
	  members: group.members
    });
}catch(error){
	res.status(500).json({
      success: false,
      message: error.message,
    });
}
});
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
//verify admin endpoint for frontend
app.get("/api/checkadmin", verifyAdmin, (req, res) => {
  res.status(200).json({
    success: true,
    isAdmin: true
  });
});
//// GET all users
app.get("/api/getallusers", requireLogin, async (req, res) => {
  try {
    const users = await User.find()
      .select("-password -__v")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      success: true,
      users
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to fetch users"
    });
  }
});
// DELETE selected users
app.delete("/bulkdelete", verifyAdmin, async (req, res) => {
  try {
    const { userIds } = req.body;

    if (!Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Please select users to delete"
      });
    }

    const result = await User.deleteMany({
      _id: { $in: userIds }
    });

    res.status(200).json({
      success: true,
      deletedCount: result.deletedCount,
      message: `${result.deletedCount} users deleted successfully`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete users"
    });
  }
});
// DELETE single user
app.delete("/users/:id", verifyAdmin, async (req, res) => {
  try {
    const user = await User.findByIdAndDelete(req.params.id);

    if (!user) {
      return res.status(404).json({
        success: false,
        message: "User not found"
      });
    }

    res.status(200).json({
      success: true,
      message: "User deleted successfully"
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete user"
    });
  }
});
// DELETE single group
app.delete("/groups/:id", verifyAdmin, async (req, res) => {
  try {
	const groupId = req.params.id;
	// Delete all messages belonging to this group
	await messageModel.deleteMany({
		groupId: groupId,
		conversationType: "group"
	});


    const deletedGroup = await groupsModel.findByIdAndDelete(groupId);
	
    if (!deletedGroup) {
      return res.status(404).json({
        success: false,
        message: "Group not found"
      });
    }
	
    res.status(200).json({
      success: true,
      message: "Group and all its messages deleted successfully"
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Failed to delete Group"
    });
  }
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
const rooms = new Set(['general', 'random']);
const usersInRooms = new Map();
const typingUsers = new Map();
io.on("connection", (socket) => {
	
	// Remove a socket from a room and its tracking collections
    function cleanupRoom(room) {

        const users = usersInRooms.get(room);
        const typing = typingUsers.get(room);

        users?.delete(socket.id);
        typing?.delete(socket.id);

        socket.leave(room);

        if (users && users.size === 0) {
            usersInRooms.delete(room);
            typingUsers.delete(room);
        } else {
            updateUserList(room);
            io.to(room).emit(
                "typing users",
                getTypingUsers(room)
            );
        }

        socket.emit("left room", room);
    }
	
	function getTypingUsers(room) {
        const users = usersInRooms.get(room);
        const typing = typingUsers.get(room);

        if (!users || !typing) return [];

        return Array.from(typing)
            .map(id => users.get(id)?.username)
            .filter(Boolean);
    }
	
	// Join a room ---      Start
	socket.on('join room', (room) => {
		
		// Leave all rooms except the default one
		socket.rooms.forEach(r => {
			if (r !== socket.id) {
				cleanupRoom(r);
			}
		});

		// Initialize user data for the room
		if (!usersInRooms.has(room)) {
			usersInRooms.set(room, new Map());
			typingUsers.set(room, new Set());
		}
		
		// Join the new room
		socket.join(room);
		// Add user to room
		usersInRooms.get(room).set(socket.id, {
			username: socket.data.user.username,
			id: socket.id
		});
		socket.emit('joined room', room);
		
		// Notify others in the room
		socket.to(room).emit('room message', {
			username: 'System',
			message: `${socket.data.user.username} has joined the room`,
			timestamp: new Date().toISOString()
		});

		// Send updated user list to room
		updateUserList(room);
	});
	// Join a room ---      End
	
	
	// Handle room creation
	socket.on('create room', (roomName) => {
		if (!rooms.has(roomName)) {
			rooms.add(roomName);
			io.emit('room created', roomName);
		}
	});
	
	// Modify message handler // Real-time chat message
	socket.on('chat message', (data) => {
		const room = String(data.room);
		if (!room || !socket.rooms.has(room)) {
			return;
		}
		//console.log("Socket user:", socket.data.user);
		//console.log("User ID:", socket.data.user?.id);
		//console.log("User ID (_id):", socket.data.user?._id);
		//socket.to(room).emit('chat message', {
		io.to(room).emit('chat message', {
			username: socket.data.user.username,
			message: data.message,
			timestamp: new Date().toISOString(),
			room: room,
			senderId: String(socket.data.user?.id)
		});
	});

	// Handle typing status
	socket.on('typing', (isTyping) => {
		const room = Array.from(socket.rooms).find(r => r !== socket.id);
		if (!room) return;
		
		if (!typingUsers.has(room)) {
            typingUsers.set(room, new Set());
        }
		
		if (isTyping) {
			typingUsers.get(room).add(socket.id);
		} else {
			typingUsers.get(room).delete(socket.id);
		}

		io.to(room).emit('typing users', getTypingUsers(room));
	});

	// Handle disconnection
	socket.on('disconnect', () => {
		
		// Remove user from all rooms
		Array.from(usersInRooms.entries()).forEach((room) => {
			if (usersInRooms.get(room)?.has(socket.id)) {
				cleanupRoom(room);
				updateUserList(room);
			}
		});
		
	});
	/*function updateUserList(room) {
		const users = Array.from(usersInRooms.get(room)?.values() || []);
		io.to(room).emit('user list', {
			room: room,
			users: users.map(u => ({
				username: u.username,
				isTyping: typingUsers.get(room)?.has(u.username) || false
			}))
		});
	}*/
	function updateUserList(room) {

    const roomUsers = usersInRooms.get(room);

    const users = roomUsers
        ? Array.from(roomUsers.entries()).map(([socketId, user]) => ({
            username: user.username,
            userId: user.userId || user.id,
            isTyping: typingUsers.get(room)?.has(socketId) || false
        }))
        : [];

    io.to(room).emit("user list", {
        room: room,
        users: users
    });

}
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


//New cloudinary and multer
const uploadToCloudinary = (file) => {
  return new Promise((resolve, reject) => {
    const publicId =
      Date.now() + '-' +
      file.originalname.replace(/[^a-zA-Z0-9.]/g, '_');

    const stream = cloudinary.uploader.upload_stream(
      {
        folder: 'chat_uploads',
        resource_type: 'auto',
        public_id: publicId
      },
      (error, result) => {
        if (error) {
          return reject(error);
        }

        resolve(result);
      }
    );

    stream.end(file.buffer);
  });
};

app.post(
  '/api/upload',
  requireLogin,
  (req, res) => {

    upload.single('file')(req, res, async (err) => {

      if (err) {
        console.error('Multer upload error:', err);

        return res.status(400).json({
          success: false,
          error: err.message || 'Upload failed'
        });
      }

      try {
        if (!req.file) {
          return res.status(400).json({
            success: false,
            error: 'No file uploaded'
          });
        }

        // Upload file to Cloudinary
        const result = await uploadToCloudinary(req.file);

        console.log('Cloudinary upload successful');

        return res.json({
          success: true,
          fileUrl: result.secure_url,
          fileName: req.file.originalname,
          fileType: req.file.mimetype,
          publicId: result.public_id
        });

      } catch (error) {
        console.error('Cloudinary upload error:', error);

        return res.status(500).json({
          success: false,
          error: 'Upload failed'
        });
      }
    });
  }
);
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