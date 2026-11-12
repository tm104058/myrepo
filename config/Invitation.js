const mongoose = require("mongoose");

const invitationSchema = new mongoose.Schema(
  {
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    phone: {
      type: String,
      required: true,
      trim: true,
      maxlength: 30,
    },

    tokenHash: {
      type: String,
      required: true,
      unique: true,
    },

    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },

    registeredUser: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    registeredAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Invitation", invitationSchema);