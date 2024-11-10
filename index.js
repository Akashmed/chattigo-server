const express = require('express');
const cors = require('cors');
const app = express();
require('dotenv').config();
const port = process.env.PORT || 5000;

const corsOptions = {
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
  optionSuccessStatus: 200,
}
app.use(cors(corsOptions));
app.use(express.json());

const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173"], // Allow requests from your React app
    methods: ["GET", "POST"]
  }
});




const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.wwbu2.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});


async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const usersCollection = client.db('chatApp').collection('users');
    const messagesCollection = client.db('chatApp').collection('messages');


    const userSocketMap = new Map();

    io.on('connection', (socket) => {
      console.log('A user connected:', socket.id);

      socket.on("userConnected", async ({ userId, sId }) => {
        userSocketMap.set(userId, socket.id); // Store user's socket ID
        console.log("Attempting to fetch undelivered messages with userId:", userId, "and senderId:", sId);

        try {
          // Check if userId and sId have correct values
          console.log("Querying with values - recipientId:", userId, "senderId:", sId, "delivered: false");

          // Fetch undelivered messages where the recipient and sender match
          const undeliveredMessages = await messagesCollection.find({
            recipientId: userId,
            senderId: sId,
          }).toArray();

          console.log("Undelivered messages found:", undeliveredMessages);

          const remainingMsgs = undeliveredMessages.filter(msgs => msgs.delivered === false);

          // Send each undelivered message to the recipient if available
          remainingMsgs.forEach((message) => {
            const recipientSocketId = userSocketMap.get(message.recipientId);
            if (recipientSocketId) {
              io.to(recipientSocketId).emit('receiveMessage', {
                senderId: message.senderId,
                text: message.text
              });
            }
          });

          // Mark messages as delivered
          await messagesCollection.updateMany(
            { recipientId: userId, senderId: sId, delivered: false },
            { $set: { delivered: true } }
          );
        } catch (error) {
          console.error("Error handling undelivered messages:", error);
        }
      });


      // Example: Listening for events from the client
      socket.on("sendMessage", async ({ senderId, recipientId, text }) => {

        const saveMessages = async (senderId, recipientId, text) => {
          const message = {
            senderId,
            recipientId,
            text,
            time: new Date(),
            delivered: false
          };
          await messagesCollection.insertOne(message);
        }
        const recipientSocketId = userSocketMap.get(recipientId);
        if (recipientSocketId) {
          // Send the message to the recipient's socket
          io.to(recipientSocketId).emit("receiveMessage", {
            senderId,
            text,
          });
          await messagesCollection.updateOne(
            { senderId, recipientId, text }, { $set: { delivered: true } }
          )
        } else {
          await saveMessages(senderId, recipientId, text);
        }
      });

      socket.on("disconnect", () => {
        userSocketMap.forEach((value, key) => {
          if (value === socket.id) {
            userSocketMap.delete(key); // Remove user from map on disconnect
          }
        });
      });
    });

    // save all users
    app.put('/users/:email', async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const query = { email: email };
      const options = { upsert: true };
      const User = {
        $set: user,
      };
      const isExist = await usersCollection.findOne(query);
      if (isExist) {
        return res.send(isExist);
      }
      const result = await usersCollection.updateOne(query, User, options);
      res.send(result);
    });

    // get all users
    app.get('/users', async (req, res) => {
      const result = await usersCollection.find().toArray();
      res.send(result);
    })

    // get all messages
    app.get('/messages/:id/:rid', async (req, res) => {
      const { id, rid } = req.params;
      console.log(id, rid);
      const query = { senderId: id, recipientId: rid,  delivered: false };
      const result = await messagesCollection.find(query).toArray();
      res.send(result);
    })



    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


server.listen(5000, () => {
  console.log('Server is running on http://localhost:5000');
});
