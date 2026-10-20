const express = require('express');
const app = express();
const http = require('http').createServer(app);
//const io = require('socket.io')(http);
const io = require('socket.io')(http, {
  cors: { origin: "*" } // Allows the Android WebView to connect safely
});

const PORT = process.env.PORT || 3000;

// Serve static frontend files from a folder named "public"
app.use(express.static('public'));

// Listen for browser connections
io.on('connection', (socket) => {
    console.log('A user connected');

    // Listen for incoming messages from a specific client
    socket.on('chat message', (msg) => {
        // Broadcast the message to all connected browsers
        io.emit('chat message', msg);
    });
	// Emit/Broadcast the android message to ALL connected clients
	socket.on('android_message', (data) => {
        console.log('Received from Android:', data);

        // 2. Emit/Broadcast the message to ALL connected clients
        io.emit('server_broadcast', {
            sender: 'Android Device',
            message: data.message,
            timestamp: new Date()
		});
	});
    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
