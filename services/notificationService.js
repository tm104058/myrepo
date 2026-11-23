import DeviceToken from "../config/DeviceToken.js";
import { messaging } from "../config/firebase.js";

export async function sendMessageNotification({
    receiverId,
    senderName,
    message,
    chatId
}) {

    try {

        const devices = await DeviceToken.find({
            userId: receiverId,
            platform: "android"
        }).lean();

        if (!devices.length) {
            return;
        }

        const tokens = devices.map(device => device.token);

        // Firebase multicast requests support up to 500 tokens.
        for (let i = 0; i < tokens.length; i += 500) {

            const batch = tokens.slice(i, i + 500);

            const responses = await Promise.allSettled(
                batch.map(token =>
                    messaging.send({
                        token,

                        data: {
                            senderName: String(senderName),
                            message: String(message).slice(0, 1000),
                            chatId: String(chatId)
                        },

                        android: {
                            priority: "high",
                            ttl: 60 * 60 * 1000
                        }
                    })
                )
            );

            const invalidTokens = [];

            responses.forEach((result, index) => {

                if (
                    result.status === "rejected" &&
                    (
                        result.reason?.code ===
                            "messaging/registration-token-not-registered" ||
                        result.reason?.code ===
                            "messaging/invalid-registration-token"
                    )
                ) {
                    invalidTokens.push(batch[index]);
                }
            });

            if (invalidTokens.length) {
                await DeviceToken.deleteMany({
                    token: { $in: invalidTokens }
                });
            }
        }

    } catch (error) {

        console.error("Notification error:", error);
    }
}