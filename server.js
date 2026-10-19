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
    /*socket.on('chat message', (msg) => {
        // Broadcast the message to all connected browsers
        io.emit('chat message', msg);
    });*/
	// Simulate sending a response from the chat webapp 3 seconds after connecting
    setTimeout(() => {
        io.emit('chat message', msg);
    }, 3000);

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

http.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
