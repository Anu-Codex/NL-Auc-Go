require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const { Server } = require('socket.io');
const cors = require('cors');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const bcrypt = require('bcryptjs');


const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

// --- BREVO CONFIG ---
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY; 
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// --- MONGO SCHEMAS ---
const userSchema = new mongoose.Schema({
    name: String, email: String, role: String, otp: String, isVerified: { type: Boolean, default: false }
});
const playerSchema = new mongoose.Schema({
    name: String, strength: Number, cardType: String, status: { type: String, default: 'Available' }, baseValue: Number, soldTo: String
});
const teamSchema = new mongoose.Schema({ name: String, budget: { type: Number, default: 1000 } });
const stateSchema = new mongoose.Schema({ activePlayerId: { type: mongoose.Schema.Types.ObjectId, ref: 'Player' }, currentBid: Number, highestBidder: String });
const chatSchema = new mongoose.Schema({ sender: String, role: String, text: String, timestamp: { type: Date, default: Date.now } });

const User = mongoose.model('User', userSchema);
const Player = mongoose.model('Player', playerSchema);
const Team = mongoose.model('Team', teamSchema);
const State = mongoose.model('State', stateSchema);
const Chat = mongoose.model('Chat', chatSchema);

// --- TIMER & AUCTION LOGIC ---
let auctionTimer = null;
let timeLeft = 60;

const startTimer = () => {
    clearInterval(auctionTimer);
    timeLeft = 60;
    io.emit('timerUpdate', timeLeft);
    auctionTimer = setInterval(async () => {
        timeLeft--;
        io.emit('timerUpdate', timeLeft);
        if (timeLeft <= 0) {
            clearInterval(auctionTimer);
            await autoSellPlayer();
        }
    }, 1000);
};

const autoSellPlayer = async () => {
    let state = await State.findOne().populate('activePlayerId');
    if (state && state.activePlayerId && state.highestBidder) {
        await Team.findOneAndUpdate({ name: state.highestBidder }, { $inc: { budget: -state.currentBid } });
        await Player.findByIdAndUpdate(state.activePlayerId, { status: 'Sold', soldTo: `${state.highestBidder} (${state.currentBid}L)` });
        state.activePlayerId = null; state.currentBid = 0; state.highestBidder = null;
        await state.save();
        io.emit('updatePlayers', await Player.find());
        io.emit('updateTeams', await Team.find());
        io.emit('updateAuction', state);
        io.emit('newMessage', { sender: "SYSTEM", text: "🔨 PLAYER SOLD!" });
    }
};

// --- AUTH HELPERS ---
const sendOTP = async (email, otp) => {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Nexus Legends OTP";
    sendSmtpEmail.htmlContent = `<html><body><h1>Your Code: ${otp}</h1></body></html>`;
    sendSmtpEmail.sender = { "name": "Nexus Legends", "email": "mysticfcmlegends@gmail.com" };
    sendSmtpEmail.to = [{ "email": email }];
    return apiInstance.sendTransacEmail(sendSmtpEmail);
};

// --- SOCKETS ---
io.on('connection', async (socket) => {
    const sync = async () => {
        socket.emit('initialData', {
            players: await Player.find(),
            teams: await Team.find(),
            state: await State.findOne().populate('activePlayerId'),
            chats: await Chat.find().sort({ timestamp: -1 }).limit(50)
        });
    };
    await sync();

    // Registration & Login
    socket.on('register', async (data) => {
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        await User.findOneAndUpdate({ email: data.email }, { ...data, otp, role: 'visitor' }, { upsert: true });
        await sendOTP(data.email, otp);
        socket.emit('authStep', 'otp');
    });

    socket.on('verifyOTP', async ({ email, otp }) => {
        const user = await User.findOne({ email, otp });
        if (user) {
            user.isVerified = true; await user.save();
            socket.emit('loginSuccess', { name: user.name, role: user.role, email: user.email });
        } else socket.emit('errorMsg', "Invalid OTP");
    });

    // Auction Controls
    socket.on('startAuction', async ({ playerId, baseValue }) => {
        let state = await State.findOne();
        state.activePlayerId = playerId; state.currentBid = baseValue; state.highestBidder = null;
        await state.save();
        startTimer();
        io.emit('updateAuction', await State.findOne().populate('activePlayerId'));
    });

    socket.on('placeBid', async ({ teamName, increment }) => {
        let state = await State.findOne();
        state.currentBid += increment; state.highestBidder = teamName;
        await state.save();
        startTimer(); // AUTO RESET TO 60s
        io.emit('updateAuction', await State.findOne().populate('activePlayerId'));
    });

    socket.on('sellPlayer', autoSellPlayer);

    socket.on('cancelAuction', async () => {
        clearInterval(auctionTimer);
        let state = await State.findOne();
        state.activePlayerId = null; await state.save();
        io.emit('updateAuction', state);
    });

    socket.on('addPlayer', async (d) => { await Player.create(d); io.emit('updatePlayers', await Player.find()); });
    socket.on('deletePlayer', async (id) => { await Player.findByIdAndDelete(id); io.emit('updatePlayers', await Player.find()); });
    socket.on('sendMessage', async (d) => { const m = await Chat.create(d); io.emit('newMessage', m); });
});

// --- RESET ROUTES ---
app.get('/reset-budget', async (req, res) => { await Team.updateMany({}, { budget: 1000 }); res.send("Budgets Reset"); });
app.get('/reset-teams', async (req, res) => { await Player.updateMany({}, { status: 'Available', soldTo: '' }); res.send("Tournament Reset"); });

mongoose.connect(process.env.MONGODB_URI).then(() => server.listen(3000));
