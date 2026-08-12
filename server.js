const express = require('express');
const tmi = require('tmi.js');
const mongoose = require('mongoose');

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => res.status(200).send('OK'));
app.listen(PORT, () => console.log(`Web server running on port ${PORT}`));

// 1. Connect to Database
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Connected to MongoDB database!'))
  .catch(err => console.error('Database connection error:', err));

// 2. Define Command Structure
const commandSchema = new mongoose.Schema({
  name: { type: String, required: true, unique: true },
  response: { type: String, required: true }
});
const Command = mongoose.model('Command', commandSchema);

// 3. Setup Twitch Client
const rawToken = (process.env.TWITCH_BOT_ACCESS_TOKEN || '').trim();
const pass = rawToken.startsWith('oauth:') ? rawToken : `oauth:${rawToken}`;

const client = new tmi.Client({
  options: { debug: true },
  identity: {
    username: (process.env.TWITCH_BOT_USERNAME || '').toLowerCase().trim(),
    password: pass
  },
  channels: [(process.env.TWITCH_CHANNEL || '').toLowerCase().trim()]
});

client.connect().catch(console.error);

// 4. Chat Handler
client.on('message', async (channel, tags, message, self) => {
  if (self) return;

  const msg = message.trim();
  const lowerMsg = msg.toLowerCase();
  const username = tags.username.toLowerCase();
  const args = msg.split(' ');
  const commandName = args[0].toLowerCase();
  
  // Check if user is broadcaster or moderator
  const isMod = tags.mod || tags['badges-raw']?.includes('broadcaster');

  // Trigger: Listen for "hog reveal" specifically from motmo_
  if (username === 'motmo_' && lowerMsg.includes('hog reveal')) {
    client.say(channel, 'Did Motmo_ say.. HOG REVEAL?');
    return;
  }

  // Managing Commands (Mods & Broadcaster Only)
  if (commandName === '!cmd' && isMod) {
    const action = args[1]?.toLowerCase(); // add, edit, delete
    const name = args[2]?.toLowerCase();    // e.g. !discord
    const response = args.slice(3).join(' '); // e.g. Join our discord!

    if (!action || !name) {
      client.say(channel, 'Usage: !cmd <add|edit|delete> <!commandname> <response>');
      return;
    }

    if (!name.startsWith('!')) {
      client.say(channel, 'Command name must start with !');
      return;
    }

    // ADD COMMAND
    if (action === 'add') {
      if (!response) return client.say(channel, 'Please provide a response text!');
      try {
        await Command.create({ name, response });
        client.say(channel, `Command ${name} created!`);
      } catch (err) {
        client.say(channel, `Command ${name} already exists. Use !cmd edit instead.`);
      }
    } 

    // EDIT COMMAND
    else if (action === 'edit') {
      if (!response) return client.say(channel, 'Please provide a response text!');
      const updated = await Command.findOneAndUpdate({ name }, { response });
      if (updated) {
        client.say(channel, `Command ${name} updated!`);
      } else {
        client.say(channel, `Command ${name} does not exist.`);
      }
    } 

    // DELETE COMMAND
    else if (action === 'delete') {
      const deleted = await Command.findOneAndDelete({ name });
      if (deleted) {
        client.say(channel, `Command ${name} removed!`);
      } else {
        client.say(channel, `Command ${name} not found.`);
      }
    }
    return;
  }

  // Respond to Custom Commands from Database
  if (commandName.startsWith('!')) {
    const customCmd = await Command.findOne({ name: commandName });
    if (customCmd) {
      client.say(channel, customCmd.response);
    }
  }
});
