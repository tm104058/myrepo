import mongoose from "mongoose";

const deviceTokenSchema = new mongoose.Schema({

    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        required: true,
        index: true
    },

    token: {
        type: String,
        required: true,
        unique: true
    },

    platform: {
        type: String,
        default: "android"
    }

}, {
    timestamps: true
});

export default mongoose.model(
    "DeviceToken",
    deviceTokenSchema
);