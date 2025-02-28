const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const app = express();
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const port = process.env.PORT || 5000;
const admin = require('firebase-admin');
const { encrypt, decrypt } = require('./encrypt');

const serviceAccount = JSON.parse(
  Buffer.from(process.env.ADMIN_SDK, 'base64').toString('utf-8')
);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:5173'];

const corsOptions = {
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ['GET', 'POST'],
  },
});


const verifyToken = async (req, res, next) => {
  const token = req.cookies?.token; // Correct way to access cookies
  if (!token) {
    return res.status(401).send({ message: 'unauthorized access' });
  }

  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET, (err, decoded) => {
    if (err) {
      console.log(err);
      return res.status(401).send({ message: 'unauthorized access' });
    }
    req.user = decoded;
    next();
  });
};




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
    // await client.connect();

    const usersCollection = client.db('chatApp').collection('users');
    const messagesCollection = client.db('chatApp').collection('messages');
    const relationsCollection = client.db('chatApp').collection('relations');


    const userSocketMap = new Map();

    io.on('connection', (socket) => {
      console.log('A user connected:', socket.id);

      socket.on("userConnected", async ({ userId, sId }) => {
        userSocketMap.set(userId, {
          socketId: socket.id,
          activeChatRecipientId: sId // The user is chatting with this recipient
        });
        const reciepientOnline = userSocketMap.get(sId);
        const senderOnline = userSocketMap.get(userId);

        if (reciepientOnline && senderOnline) {
          io.to(senderOnline.socketId).emit('userOnline', { userId });
        };

        if (reciepientOnline && senderOnline) {
          io.to(reciepientOnline.socketId).emit('userOnline', { userId });
        };

        try {
          // Check if userId and sId have correct values
          console.log("Querying with values - recipientId:", userId, "senderId:", sId, "delivered: false");

          // Fetch undelivered messages where the recipient and sender match
          const undeliveredMessages = await messagesCollection.find({
            recipientId: userId,
            senderId: sId,
          }).toArray();

          // console.log("Undelivered messages found:", undeliveredMessages);

          const remainingMsgs = undeliveredMessages.filter(msgs => msgs.delivered === false);

          // Send each undelivered message to the recipient if available
          remainingMsgs.forEach((message) => {
            const recipientData = userSocketMap.get(message.recipientId);
            if (recipientData.socketId) {
              io.to(recipientData.socketId).emit('receiveMessage', {
                senderId: message.senderId,
                text: decrypt(message.text)
              });
            }
          });

          // Mark messages as delivered
          // await messagesCollection.updateMany(
          //   { recipientId: userId, senderId: sId, delivered: false },
          //   { $set: { delivered: true } }
          // );

          await messagesCollection.deleteMany({ recipientId: userId, senderId: sId });
        } catch (error) {
          console.error("Error handling undelivered messages:", error);
        }
      });

      // Define saveMessages function outside to prevent re-declaration each time
      const saveMessages = async (senderId, recipientId, text) => {
        const message = {
          senderId,
          recipientId,
          text: encrypt(text),
          time: new Date(),
          delivered: false,
        };
        await messagesCollection.insertOne(message);
      };

      socket.on("sendMessage", async ({ senderId, recipientId, text }) => {
        try {
          const recipientData = userSocketMap.get(recipientId);

          if (recipientData && recipientData.activeChatRecipientId === senderId) {
            // Recipient is actively chatting
            io.to(recipientData.socketId).emit("receiveMessage", { senderId, text });
          } else {
            // Recipient is not actively chatting
            await saveMessages(senderId, recipientId, text);
          }
        } catch (error) {
          console.error("Error handling sendMessage:", error);
        }
      });


      socket.on("disconnect", () => {
        for (const [userId, data] of userSocketMap.entries()) {
          if (data.socketId === socket.id) {
            userSocketMap.delete(userId); // Remove the user entry
            console.log(`User ${userId} disconnected.`);
            io.emit("userOffline", { userId }); // Notify others
            break;
          }
        }
      });

    });


    // auth related api
    app.post('/jwt', async (req, res) => {
      try {
        const user = req.body;
        const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
          expiresIn: '365d',
        });
        res
          .cookie('token', token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict'
          })
          .status(200)
          .send({ success: true });
      } catch (error) {
        res.status(500).send({ success: false, message: 'Internal Server Error' });
      }
    });

    // logout
    app.get('/logout', async (req, res) => {
      try {
        res
          .clearCookie('token', {
            maxAge: 0,
            secure: process.env.NODE_ENV === 'production',
            sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict'
          })
          .send({ success: true });
        console.log('logout successful')
      } catch (err) {
        res.status(500).send(err);
      }
    })


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
    app.get('/messages/:id/:rid', verifyToken, async (req, res) => {
      const { id, rid } = req.params;
      console.log(id, rid);

      const query = { senderId: id, recipientId: rid, delivered: false };
      const messages = await messagesCollection.find(query).toArray();

      // Decrypt each message
      const result = messages.map(msg => {
        return {
          ...msg,
          text:decrypt(msg.text)
        };
      });

      res.send(result); 
    });


    // get all received messages
    app.get('/receivedMsg/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const query = {
          $and: [
            { recipientId: id },
            { delivered: false }
          ]
        };

        // Step 1: Aggregate messages to count them by senderId
        const messageCounts = await messagesCollection.aggregate([
          { $match: query }, // Filter the messages
          {
            $group: {
              _id: "$senderId", // Group by senderId
              messageCount: { $sum: 1 } // Count the messages
            }
          }
        ]).toArray();

        // Step 2: Extract senderIds from the aggregated result
        const userIds = messageCounts.map(item => new ObjectId(item._id));

        // Step 3: Fetch user information from the usersCollection
        const users = await usersCollection.find({ _id: { $in: userIds } }).toArray();

        // Step 4: Combine user information with message counts
        const response = users.map(user => {
          const countInfo = messageCounts.find(count => count._id.toString() === user._id.toString());
          return {
            ...user,
            messageCount: countInfo ? countInfo.messageCount : 0 // Add message count to the user object
          };
        });

        // Send the response
        res.status(200).send(response);
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "An error occurred while fetching data." });
      }
    });

    // get all user requests and count
    app.get('/rqstsReceived/:id', verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const query = {
          $and: [
            { recepientId: id },
            { status: 'pending' }
          ]
        };

        const requests = await relationsCollection.find(query).toArray();
        const userIds = requests.map(request => new ObjectId(request.senderId));
        const users = await usersCollection.find({ _id: { $in: userIds } }).toArray();

        const response = {
          requestsCount: requests.length,
          users,
        };

        res.status(200).send(response);
      } catch (err) {
        console.error('An error occurred:', err);
        res.status(500).send({ message: 'An error occurred while processing the request.' });
      }
    });


    // set relations
    app.post('/relations', async (req, res) => {
      const doc = req.body;
      const sid = doc.senderId;
      const rid = doc.recepientId;
      const query = { senderId: sid, recepientId: rid };
      const isSent = await relationsCollection.findOne(query);
      if (isSent) return res.send('exists');

      const result = await relationsCollection.insertOne(doc);
      res.send(result);
    })

    // get relation status
    app.get('/relation/:myId/:rId', verifyToken, async (req, res) => {
      const { myId, rId } = req.params;
      let query = { recepientId: rId, senderId: myId };
      let result = await relationsCollection.findOne(query);
      if (result === null) {
        query = { recepientId: myId, senderId: rId };
        result = await relationsCollection.findOne(query);
      }
      res.send(result);
    });

    // update relation or accept request
    app.patch('/accept/:myId/:sId', async (req, res) => {
      const { myId, sId } = req.params;
      const query = {
        $and: [
          { recepientId: myId },
          { senderId: sId },
          { status: 'pending' }
        ]
      };
      const updatedDoc = {
        $set: {
          status: 'known'
        }
      };
      const result = await relationsCollection.updateOne(query, updatedDoc);
      res.send(result);
    })

    // find friends 
    app.get('/friends/:id', verifyToken, async (req, res) => {
      const { id } = req.params;
      const query = {
        status: 'known',
        $or: [
          { senderId: id },
          { recepientId: id }
        ]
      };
      const results = await relationsCollection.find(query).toArray();

      const otherUserIds = results.map(doc =>
        doc.senderId === id ? new ObjectId(doc.recepientId) : new ObjectId(doc.senderId)
      );

      const friends = await usersCollection.find({ _id: { $in: otherUserIds } }).toArray();
      res.send(friends);
    })

    // delete request and unfriend
    app.delete('/dltRelations/:myId/:id', async (req, res) => {
      const { myId, id } = req.params;
      const query = {
        $and: [
          {
            $or: [
              { senderId: id },
              { recepientId: id }
            ]
          },
          {
            $or: [
              { senderId: myId },
              { recepientId: myId }
            ]
          }
        ]
      };
      const result = await relationsCollection.deleteOne(query);
      res.send(result);
    })

    // get search results
    app.get('/search', async (req, res) => {
      const { query } = req.query;
      const results = await usersCollection.find({ name: { $regex: query, $options: 'i' } }).toArray();
      res.send(results);
    })

    // update bio
    app.patch('/bio/:id', async (req, res) => {
      const { id } = req.params;
      const { bio, name, photo } = req.body;

      // Build the update object dynamically
      const updatedFields = {};
      if (name) updatedFields.name = name;
      if (bio) updatedFields.bio = bio;
      if (photo !== null && photo !== undefined) updatedFields.photo = photo;

      const query = { _id: new ObjectId(id) };
      const updatedInfo = { $set: updatedFields };

      const result = await usersCollection.updateOne(query, updatedInfo);
      res.send(result);

    })

    // delete user (Admin)
    app.delete('/dltUser/:id', async (req, res) => {
      const { id } = req.params;

      try {
        const query = { _id: new ObjectId(id) };
        const user = await usersCollection.findOne(query);

        if (!user) {
          return res.status(404).send({ message: 'User not found in MongoDB' });
        }

        const userEmail = user.email;

        // Firebase: Fetch the UID by email
        const userRecord = await admin.auth().getUserByEmail(userEmail);
        const uid = userRecord.uid;

        // Firebase: Delete the user from Firebase Authentication
        await admin.auth().deleteUser(uid);
        console.log(`Successfully deleted user with UID: ${uid} and email: ${userEmail}`);

        // MongoDB: Delete the user document
        const deleteResult = await usersCollection.deleteOne(query);
        if (deleteResult.deletedCount === 0) {
          return res.status(500).send({ message: 'Failed to delete user from MongoDB' });
        }

        res.send({ message: 'User successfully deleted from Firebase and MongoDB' });
      } catch (error) {
        console.error('Error deleting user:', error);
        res.status(500).send({ message: 'Failed to delete user', error });
      }
    });


    // Send a ping to confirm a successful connection
    // await client.db("admin").command({ ping: 1 });
    // console.log("Pinged your deployment. You successfully connected to MongoDB!");
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);


server.listen(5000, () => {
  console.log('Server is running on http://localhost:5000');
});