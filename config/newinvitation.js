const express = require("express");
const crypto = require("crypto");
const mongoose = require("mongoose");
//const Invitation = require("../config/Invitation");
const Invitation = require("Invitation");
// Replace this import with your existing auth middleware.
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

const APP_BASE_URL = process.env.APP_BASE_URL;

function hashToken(token) {
  return crypto
    .createHash("sha256")
    .update(token)
    .digest("hex");
}

router.post("/", requireAuth, async (req, res) => {
  try {
    if (!APP_BASE_URL) {
      return res.status(500).json({
        message: "Invitation URL is not configured",
      });
    }

    const userId = req.user?.id;

    if (!mongoose.isValidObjectId(userId)) {
      return res.status(401).json({
        message: "Authentication required",
      });
    }

    const phone = String(req.body.phone || "").trim();

    // Basic validation; use a phone-number library for production
    // if you need full international number validation.
    if (!/^\+?[0-9().\-\s]{7,25}$/.test(phone)) {
      return res.status(400).json({
        message: "Invalid phone number",
      });
    }

    // Random, unguessable token; only its hash is stored.
    const token = crypto.randomBytes(32).toString("hex");

    const expiresAt = new Date(
      Date.now() + 7 * 24 * 60 * 60 * 1000
    );

    await Invitation.create({
      invitedBy: userId,
      phone,
      tokenHash: hashToken(token),
      expiresAt,
    });

    const baseUrl = APP_BASE_URL.replace(/\/+$/, "");
    const inviteUrl = `${baseUrl}/invite/${token}`;

    return res.status(201).json({
      inviteUrl,
      expiresAt,
    });
  } catch (error) {
    console.error("Create invitation error:", error);

    return res.status(500).json({
      message: "Could not create invitation",
    });
  }
});

module.exports = router;