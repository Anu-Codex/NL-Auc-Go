require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const bcrypt = require('bcryptjs');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

mongoose.connect(process.env.MONGO_URI).then(() => console.log("✅ Connected to MongoDB"));

// --- BREVO CONFIG ---
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

// --- SCHEMAS ---
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: { type: String },
    role: { type: String, default: 'visitor' }, // visitor, captain, admin
    isVerified: { type: Boolean, default: false },
    otp: String,
    otpExpires: Date
});

const playerSchema = new mongoose.Schema({
    name: String, strength: Number, cardType: String, baseValue: Number,
    status: { type: String, default: 'Available' }, soldTo: { type: String, default: '-' }
});

const teamSchema = new mongoose.Schema({ name: String, budget: Number });

const chatSchema = new mongoose.Schema({ 
    sender: String, role: String, text: String, timestamp: { type: Date, default: Date.now } 
});

const User = mongoose.model('User', userSchema);
const Player = mongoose.model('Player', playerSchema);
const Team = mongoose.model('Team', teamSchema);
const Chat = mongoose.model('Chat', chatSchema);

// --- HARDCODED CREDENTIALS (As requested) ---
const ADMINS = [
    { email: "admin@nexus.com", name: "Nexus Admin", pass: "admin123" }
];

const CAPTAINS = [
    { email: "surjanshu@mystic.com", name: "Virat FC", pass: "surjanshu123" },
    { email: "ahitagni@mystic.com", name: "Neimesis eSports", pass: "ahitagni123" },
    { email: "ritam@mystic.com", name: "Team ICONIC", pass: "ritam123" },
    { email: "anish@mystic.com", name: "Bluster FC", pass: "anish123" },
    { email: "debatreya@mystic.com", name: "Let it go na", pass: "debatreya123" },
    { email: "hitanshu@mystic.com", name: "Skystrikers United", pass: "hitanshu123" },
    { email: "aritra@mystic.com", name: "MI CHAMPSS", pass: "aritra123" },
    { email: "nil@mystic.com", name: "ELITE MSN", pass: "nil123" },
    { email: "debojit@mystic.com", name: "Visca", pass: "debojit123" },
    { email: "arghya@mystic.com", name: "PREDETORS TRIO", pass: "arghya123" }
];

// --- AUTH UTILITIES ---
async function sendOTPEmail(email, otp) {
    const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
    sendSmtpEmail.subject = "Nexus Legends Verification Code";
    sendSmtpEmail.htmlContent = `<html><body><h1>Your OTP: ${otp}</h1><p>Use this code to verify your account.</p></body></html>`;
    sendSmtpEmail.sender = { "name": "Nexus Legends", "email": process.env.BREVO_SENDER_EMAIL };
    sendSmtpEmail.to = [{ "email": email }];
    return apiInstance.sendTransacEmail(sendSmtpEmail);
}

// --- AUTOMATIC TEAM SEEDING ---
const teamList = [
    { name: "Virat FC", budget: 100 },
    { name: "Neimesis eSports", budget: 100 },
    { name: "Team ICONIC", budget: 100 },
    { name: "Bluster FC", budget: 100 },
    { name: "Let it go na", budget: 100 },
    { name: "Skystrikers United", budget: 100 },
    { name: "MI CHAMPSS", budget: 100 },
    { name: "ELITE MSN", budget: 100 },
    { name: "Visca", budget: 100 },
    { name: "PREDETORS TRIO", budget: 100 }
];

async function seedTeams() {
    for (let t of teamList) {
        const exists = await Team.findOne({ name: t.name });
        if (!exists) {
            await new Team(t).save();
            console.log(`🌱 Seeded team: ${t.name}`);
        }
    }
}
seedTeams();

// --- HTTP ROUTES ---
app.get('/reset-teams', async (req, res) => {
    try {
        await Team.deleteMany({}); 
        await Team.insertMany(teamList);
        res.send("✅ Teams successfully reset to 100L!");
    } catch (e) { res.status(500).send(e.message); }
});

app.get('/fix-budgets', async (req, res) => {
    try {
        await Team.updateMany({}, { $set: { budget: 100 } });
        res.send("✅ All budgets reset to 100L!");
    } catch (e) { res.status(500).send(e.message); }
});

// --- AUCTION LOGIC & TIMER ---
let auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 60 };
let timerInterval = null;

function startTimer() {
    clearInterval(timerInterval);
    auctionState.timeLeft = 60;
    timerInterval = setInterval(async () => {
        auctionState.timeLeft--;
        if (auctionState.timeLeft <= 0) {
            clearInterval(timerInterval);
            await autoSellPlayer();
        } else {
            io.emit('updateAuction', auctionState);
        }
    }, 1000);
}

async function autoSellPlayer() {
    if (auctionState.activePlayerId && auctionState.highestBidder !== 'No Bids Yet') {
        const price = auctionState.currentBid;
        const teamName = auctionState.highestBidder;

        await Player.findByIdAndUpdate(auctionState.activePlayerId._id, {
            status: 'Sold',
            soldTo: `${teamName} (${price}L)`
        });
        await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: -price } });

        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        
        io.emit('updatePlayers', await Player.find());
        io.emit('updateTeams', await Team.find());
        io.emit('updateAuction', auctionState);
        io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `🔴 SOLD! ${teamName} bought the player for ${price}L.` });
    } else {
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    }
}

// --- SOCKETS ---
io.on('connection', async (socket) => {
    socket.emit('initialData', {
        players: await Player.find(),
        teams: await Team.find(),
        chats: await Chat.find().sort({ timestamp: 1 }).limit(50),
        state: auctionState
    });

    // --- NEW: AUTHENTICATION EVENTS ---

    // 1. Visitor Registration
    socket.on('register', async (data) => {
        try {
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            const hashedPassword = await bcrypt.hash(data.password, 10);
            
            await User.findOneAndUpdate(
                { email: data.email },
                { 
                    name: data.name, 
                    password: hashedPassword, 
                    role: 'visitor', 
                    otp, 
                    otpExpires: Date.now() + 600000, 
                    isVerified: false 
                },
                { upsert: true }
            );
            
            await sendOTPEmail(data.email, otp);
            socket.emit('authStep', 'otp_verify');
        } catch (err) { 
            console.error(err);
            socket.emit('errorMsg', "Registration Failed"); 
        }
    });

    // 2. Special Sign In (Captain/Admin)
    socket.on('specialSignIn', async ({ email, password, type }) => {
        const list = type === 'admin' ? ADMINS : CAPTAINS;
        const entry = list.find(u => u.email === email && u.pass === password);
        
        if (entry) {
            const otp = Math.floor(100000 + Math.random() * 900000).toString();
            await User.findOneAndUpdate(
                { email },
                { 
                    name: entry.name, 
                    role: type, 
                    otp, 
                    otpExpires: Date.now() + 600000, 
                    isVerified: true 
                },
                { upsert: true }
            );
            await sendOTPEmail(email, otp);
            socket.emit('authStep', 'otp_verify');
        } else {
            socket.emit('errorMsg', "Invalid Authorized Credentials");
        }
    });

    // 3. Verify OTP
    socket.on('verifyOTP', async ({ email, otp }) => {
        try {
            const user = await User.findOne({ 
                email, 
                otp, 
                otpExpires: { $gt: Date.now() } 
            });

            if (user) {
                user.isVerified = true;
                user.otp = undefined;
                await user.save();
                socket.emit('loginSuccess', { name: user.name, role: user.role, email: user.email });
            } else {
                socket.emit('errorMsg', "Invalid or Expired OTP");
            }
        } catch (err) {
            socket.emit('errorMsg', "Verification Error");
        }
    });

    // --- PREVIOUS AUCTION FUNCTIONS (UNTOUCHED) ---

    socket.on('addPlayer', async (data) => {
        try {
            const newPlayer = new Player({ ...data, strength: Number(data.strength), baseValue: Number(data.baseValue) });
            await newPlayer.save();
            io.emit('updatePlayers', await Player.find()); 
        } catch (err) { console.error(err); }
    });

    socket.on('startAuction', async ({ playerId, baseValue }) => {
        const player = await Player.findById(playerId);
        if (player) {
            auctionState = { activePlayerId: player, currentBid: baseValue, highestBidder: 'No Bids Yet', timeLeft: 60 };
            io.emit('updateAuction', auctionState);
            startTimer();
        }
    });

    socket.on('placeBid', async ({ teamName, increment }) => {
        const team = await Team.findOne({ name: teamName });
        const newBid = auctionState.currentBid + increment;
        if (team && team.budget >= newBid) {
            auctionState.currentBid = newBid;
            auctionState.highestBidder = teamName;
            startTimer(); 
            io.emit('updateAuction', auctionState);
        }
    });

    socket.on('sellPlayer', autoSellPlayer);
    socket.on('cancelAuction', () => {
        clearInterval(timerInterval);
        auctionState = { activePlayerId: null, currentBid: 0, highestBidder: 'No Bids Yet', timeLeft: 0 };
        io.emit('updateAuction', auctionState);
    });

    socket.on('addBonus', async ({ teamName, amount }) => {
        try {
            await Team.findOneAndUpdate({ name: teamName }, { $inc: { budget: Number(amount) } });
            io.emit('updateTeams', await Team.find());
            io.emit('newMessage', { sender: "SYSTEM", role: "admin", text: `✨ ${teamName} purse adjusted by ${amount}L!` });
        } catch (err) { console.error(err); }
    });

    socket.on('sendMessage', async (data) => {
        // Simple security check: Only allow chat if user is verified (optional)
        await new Chat(data).save();
        io.emit('newMessage', data);
    });

    socket.on('deletePlayer', async (playerId) => {
        await Player.findByIdAndDelete(playerId);
        io.emit('updatePlayers', await Player.find()); 
    });
});

server.listen(process.env.PORT || 3000, () => console.log("Server Running"));
