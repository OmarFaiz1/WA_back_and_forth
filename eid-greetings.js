/**
 * Eid Greetings WhatsApp Sender
 * Standalone application to send Eid Mubarak messages to any WhatsApp number (saved or unsaved)
 * with session management, delivery verification, and immediate "yes" or "no" reply detection
 */

// Import required libraries
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
require('dotenv').config();

// Configuration for the messages
const MESSAGE_CONFIG = {
  messageText: process.env.DEFAULT_MESSAGE || "Eid Mubarak! May this blessed occasion bring joy, health, and prosperity to you and your loved ones. 🌙✨",
  delayBetweenMessages: parseInt(process.env.DEFAULT_DELAY, 10) || 3000,
  replyTimeout: 60000, // 1 minute timeout for reply detection
  dryRun: false
};

// Create WhatsApp client instance
let client = null;

/**
 * Initialize the WhatsApp client
 */
async function initializeClient() {
  if (client) return;

  console.log('Initializing WhatsApp client...');
  
  client = new Client({
    authStrategy: new LocalAuth({
      clientId: 'eid-greetings-sender',
      dataPath: './.wwebjs_auth'
    }),
    puppeteer: {
      headless: process.env.HEADLESS_MODE !== 'false',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-extensions'
      ]
    }
  });

  client.on('qr', (qr) => {
    console.log('Scan this QR code with your WhatsApp:');
    qrcode.generate(qr, { small: true });
  });

  client.on('authenticated', () => {
    console.log('Authentication successful!');
  });

  client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
    process.exit(1);
  });

  client.on('ready', () => {
    console.log('WhatsApp client is ready to use!');
    runMain();
  });

  client.on('disconnected', (reason) => {
    console.log('Client disconnected:', reason);
    client = null;
    initializeClient();
  });

  try {
    await client.initialize();
  } catch (error) {
    console.error('Failed to initialize client:', error);
    process.exit(1);
  }
}

/**
 * Get all contacts from WhatsApp
 * @returns {Promise<Array>} - Array of contact objects
 */
async function getAllContacts() {
  try {
    console.log('Retrieving all contacts...');
    const contacts = await client.getContacts();
    console.log(`Found ${contacts.length} contacts`);
    return contacts;
  } catch (error) {
    console.error('Error retrieving contacts:', error);
    throw error;
  }
}

/**
 * Send Eid Mubarak message and listen for "yes" or "no" reply
 * @param {Object} contact - Contact object from WhatsApp
 * @returns {Promise<Object>} - Result of the send operation
 */
async function sendEidMessage(contact) {
  try {
    if (!client.info) {
      throw new Error('Client is not ready. Please check the session.');
    }

    const { id, name, pushname, number } = contact;
    const displayName = name || pushname || number || id.user || 'Unknown';
    
    console.log(`Sending Eid Mubarak message to ${displayName} (${id.user})...`);
    
    if (MESSAGE_CONFIG.dryRun) {
      console.log(`[DRY RUN] Would send to ${displayName}: "${MESSAGE_CONFIG.messageText}"`);
      return { success: true, contact, dryRun: true };
    }
    
    const sentMessage = await client.sendMessage(id._serialized, MESSAGE_CONFIG.messageText);
    if (!sentMessage) {
      throw new Error('No message object returned from sendMessage');
    }
    
    console.log(`✅ Message sent successfully to ${displayName}`);
    console.log(`Message ID: ${sentMessage.id._serialized}`);
    console.log(`Timestamp: ${new Date(sentMessage.timestamp * 1000).toLocaleString()}`);
    
    // Wait and check the ACK status for delivery confirmation
    let attempts = 0;
    const maxAttempts = 5; // Wait up to 10 seconds (5 * 2 seconds)
    while (sentMessage.ack < 1 && attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      attempts++;
      console.log(`Checking ACK status, attempt ${attempts}: ${sentMessage.ack}`);
    }
    
    if (sentMessage.ack >= 1) {
      console.log('✅ Message delivered to the recipient\'s phone.');
    } else {
      console.log('⚠️ Message sent to server but not delivered after waiting.');
      console.log('Possible reasons: Recipient offline, number not on WhatsApp, or server delay.');
    }
    
    // Verify if the message is in the chat history
    try {
      const chat = await client.getChatById(contact.id._serialized);
      const messages = await chat.fetchMessages({ limit: 5 });
      const isMessageInChat = messages.some(msg => msg.id._serialized === sentMessage.id._serialized);
      if (isMessageInChat) {
        console.log('✅ Message found in chat history.');
      } else {
        console.log('❌ Message not found in chat history.');
      }
    } catch (error) {
      console.error('Error fetching chat or messages:', error);
    }
    
    // Listen for immediate "yes" or "no" reply
    console.log(`Listening for immediate reply from ${displayName}...`);
    const replyListener = (message) => {
      if (message.from === id._serialized) {
        const reply = message.body.toLowerCase();
        if (reply === 'yes' || reply === 'no') {
          console.log(`✅ Received immediate reply from ${displayName}: "${reply}"`);
          client.off('message', replyListener); // Stop listening after valid reply
        }
      }
    };
    
    client.on('message', replyListener);
    
    // Stop listening after timeout
    setTimeout(() => {
      client.off('message', replyListener);
      console.log(`⏳ Stopped listening for reply from ${displayName} after ${MESSAGE_CONFIG.replyTimeout / 1000} seconds.`);
    }, MESSAGE_CONFIG.replyTimeout);
    
    return { success: true, contact, messageId: sentMessage.id._serialized };
  } catch (error) {
    console.error(`❌ Failed to send message to ${contact.name || contact.pushname || contact.id.user || 'Unknown'}:`, error.message);
    return { success: false, contact, error: error.message };
  }
}

/**
 * List all contacts from WhatsApp and return them
 * @returns {Promise<Array>} - Array of contact objects
 */
async function listAllContacts() {
  try {
    const contacts = await getAllContacts();
    console.log('\n--- All WhatsApp Contacts ---');
    contacts.forEach((contact, index) => {
      const { id, name, pushname, number, isGroup, isMyContact } = contact;
      const displayName = name || pushname || number || id.user;
      console.log(`${index + 1}. ${displayName} (${id.user}) - ${isGroup ? 'Group' : 'Contact'}${isMyContact ? ' (Saved)' : ''}`);
    });
    console.log('-----------------------------\n');
    return contacts;
  } catch (error) {
    console.error('Error listing contacts:', error);
    throw error;
  }
}

/**
 * Main function that runs when the client is ready
 */
async function runMain() {
  try {
    const contacts = await listAllContacts();
    
    const readline = require('readline').createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    readline.question('Enter the contact\'s phone number (with country code, digits only, e.g., 12345678900): ', async (enteredNumber) => {
      // Try to find the contact in the list (saved or unsaved)
      let contact = contacts.find(c => c.id.user === enteredNumber && !c.isGroup);
      
      // If not found, create a contact object for an unsaved number
      if (!contact) {
        console.log(`Number ${enteredNumber} not found in contacts. Treating as an unsaved number.`);
        contact = {
          id: {
            user: enteredNumber,
            _serialized: `${enteredNumber}@c.us`
          }
        };
      }
      
      if (contact) {
        const result = await sendEidMessage(contact);
        if (result.success && !MESSAGE_CONFIG.dryRun) {
          console.log('Keeping script alive to listen for replies. Press Ctrl+C to exit.');
        }
      } else {
        console.log('Invalid input or group number provided.');
        readline.close();
        process.exit(0);
      }
      readline.close();
      // Note: Process does not exit immediately to allow reply detection
    });
  } catch (error) {
    console.error('Error in main execution:', error);
    process.exit(1);
  }
}

/**
 * Command line argument handling
 */
function handleCommandLineArgs() {
  const args = process.argv.slice(2);
  
  if (args.includes('--list-only') || args.includes('-l')) {
    client.on('ready', async () => {
      await listAllContacts();
      process.exit(0);
    });
  }
  
  if (args.includes('--dry-run') || args.includes('-d')) {
    MESSAGE_CONFIG.dryRun = true;
    console.log('Dry run mode enabled. No messages will be sent.');
  }
  
  const messageIndex = args.findIndex(arg => arg === '--message' || arg === '-m');
  if (messageIndex !== -1 && args.length > messageIndex + 1) {
    MESSAGE_CONFIG.messageText = args[messageIndex + 1];
    console.log(`Custom message set: "${MESSAGE_CONFIG.messageText}"`);
  }
  
  const delayIndex = args.findIndex(arg => arg === '--delay' || arg === '-t');
  if (delayIndex !== -1 && args.length > delayIndex + 1) {
    const delay = parseInt(args[delayIndex + 1], 10);
    if (!isNaN(delay) && delay > 0) {
      MESSAGE_CONFIG.delayBetweenMessages = delay;
      console.log(`Custom delay set: ${delay}ms`);
    }
  }
}

// Process command line arguments
handleCommandLineArgs();

// Start the application
initializeClient();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nGracefully shutting down...');
  if (client) {
    console.log('Closing WhatsApp client...');
    await client.destroy();
  }
  process.exit(0);
});