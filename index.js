const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const app = express();
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
require('dotenv').config();
const port = process.env.PORT || 5000;

const corsOptions = {
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
  optionSuccessStatus: 200,
}
app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

const http = require('http');
const { Server } = require('socket.io');

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5173"], // Allow requests from your React app
    methods: ["GET", "POST"]
  }
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
    await client.connect();

    const usersCollection = client.db('chatApp').collection('users');
    const messagesCollection = client.db('chatApp').collection('messages');
    const relationsCollection = client.db('chatApp').collection('relations');


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

          // console.log("Undelivered messages found:", undeliveredMessages);

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
          text,
          time: new Date(),
          delivered: false,
        };
        await messagesCollection.insertOne(message);
      };

      socket.on("sendMessage", async ({ senderId, recipientId, text }) => {

        const recipientSocketId = await userSocketMap.get(recipientId);

        if (recipientSocketId) {
          io.to(recipientSocketId).emit("receiveMessage", { senderId, text });

          // Update the message to mark it as delivered
          // await messagesCollection.updateOne(
          //   { senderId, recipientId, text },
          //   { $set: { delivered: true } }
          // );
        } else {
          // If recipient is offline, save the message to the database
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


    // auth related api
    app.post('/jwt', async (req, res) => {
      const user = req.body;
      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn: '365d',
      })
      res
        .cookie('token', token, {
          httpOnly: true,
          secure: process.env.NODE_ENV === 'production',
          sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'strict'
        })
        .send({ success: true })
    })

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
      const result = await messagesCollection.find(query).toArray();
      res.send(result);
    })

    // get all received messages
    app.get('/receivedMsg/:id',verifyToken, async (req, res) => {
      try {
        const { id } = req.params;
        const query = {
          $and: [
            { recipientId: id },
            { delivered: false }
          ]
        };

        const messages = await messagesCollection.find(query).toArray();
        const userIds = messages.map(message => new ObjectId(message.senderId));
        const users = await usersCollection.find({ _id: { $in: userIds } }).toArray();

        const response = {
          messagesCount: messages.length,
          users,
        };

        res.status(200).send(response);
      } catch (err) {
        console.error('An error occurred:', err);
        res.status(500).send({ message: 'An error occurred while processing the request.' });
      }
    });

    // get all user requests and count
    app.get('/rqstsReceived/:id',verifyToken, async (req, res) => {
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
    app.get('/relation/:myId/:rId',verifyToken, async (req, res) => {
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
    app.get('/friends/:id',verifyToken, async (req, res) => {
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
