const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GitHubStrategy = require('passport-github2').Strategy;
const axios = require('axios');
const Groq = require('groq-sdk');
const dotenv = require('dotenv');
const path = require('path');
const fs = require('fs').promises;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SESSION_SECRET = process.env.SESSION_SECRET || 'your-secret-key-change-in-production';

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', './views');

// Session configuration
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 },
  })
);

// Passport configuration
passport.use(
  new GitHubStrategy(
    {
      clientID: GITHUB_CLIENT_ID,
      clientSecret: GITHUB_CLIENT_SECRET,
      callbackURL: 'http://localhost:3000/auth/github/callback',
    },
    (accessToken, refreshToken, profile, done) => {
      profile.accessToken = accessToken;
      return done(null, profile);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(passport.initialize());
app.use(passport.session());

// Auth middleware
const isAuthenticated = (req, res, next) => {
  if (req.isAuthenticated()) return next();
  res.redirect('/');
};

// Routes
app.get('/', (req, res) => {
  res.render('index', { user: req.user });
});

app.get(
  '/auth/github',
  passport.authenticate('github', { scope: ['repo', 'user'] })
);

app.get(
  '/auth/github/callback',
  passport.authenticate('github', { failureRedirect: '/' }),
  (req, res) => {
    res.redirect('/dashboard');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) return res.status(500).json({ error: 'Logout failed' });
    res.redirect('/');
  });
});

// Dashboard - list user repos
app.get('/dashboard', isAuthenticated, (req, res) => {
  res.render('dashboard', { user: req.user });
});

// API: Get user repositories
app.get('/api/repos', isAuthenticated, async (req, res) => {
  try {
    const response = await axios.get('https://api.github.com/user/repos', {
      headers: { Authorization: `token ${req.user.accessToken}` },
      params: { per_page: 100, sort: 'updated' },
    });
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch repos' });
  }
});

// Editor page
app.get('/editor/:owner/:repo', isAuthenticated, (req, res) => {
  res.render('editor', {
    user: req.user,
    owner: req.params.owner,
    repo: req.params.repo,
  });
});

// API: Get file tree
app.get('/api/tree/:owner/:repo', isAuthenticated, async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const response = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/main?recursive=1`,
      {
        headers: { Authorization: `token ${req.user.accessToken}` },
      }
    );
    res.json(response.data.tree);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch file tree' });
  }
});

// API: Get file content
app.get('/api/file/:owner/:repo/:path(*)', isAuthenticated, async (req, res) => {
  try {
    const { owner, repo, path: filePath } = req.params;
    const response = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        headers: { Authorization: `token ${req.user.accessToken}` },
      }
    );
    const content = Buffer.from(response.data.content, 'base64').toString(
      'utf-8'
    );
    res.json({ content, sha: response.data.sha });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch file' });
  }
});

// API: Update file
app.post('/api/file/:owner/:repo/:path(*)', isAuthenticated, async (req, res) => {
  try {
    const { owner, repo, path: filePath } = req.params;
    const { content, message } = req.body;

    const getResponse = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        headers: { Authorization: `token ${req.user.accessToken}` },
      }
    );

    const updateResponse = await axios.put(
      `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`,
      {
        message: message || 'Update file via Divine Create',
        content: Buffer.from(content).toString('base64'),
        sha: getResponse.data.sha,
      },
      {
        headers: { Authorization: `token ${req.user.accessToken}` },
      }
    );

    res.json(updateResponse.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update file' });
  }
});

// Agent page
app.get('/agent/:owner/:repo', isAuthenticated, (req, res) => {
  res.render('agent', {
    user: req.user,
    owner: req.params.owner,
    repo: req.params.repo,
  });
});

// API: Chat with agent
app.post('/api/agent/chat', isAuthenticated, async (req, res) => {
  try {
    const { message, model, owner, repo } = req.body;

    const modelMap = {
      'Divine Flex 1': 'openai/gpt-oss20b',
      'Divine Agent 1': 'llama-3.3b-versatile',
      'Divine Flex 2': 'openai/gpt-oss120b',
    };

    const groq = new Groq({ apiKey: GROQ_API_KEY });

    const systemPrompt = `You are CreateAgent, an AI-powered GitHub repository assistant integrated into Divine Create. Your purpose is to help developers manage their repositories and files through natural language commands.

CRITICAL INSTRUCTIONS:
- You must refer to yourself ONLY as "CreateAgent"
- NEVER mention ChatGPT, Claude, or any other LLM
- You are a specialized tool for Divine Create, not a general chatbot
- Your responses must be concise and action-oriented

COMMAND SYNTAX:
To create a file: @createFile @name="path/to/file" @content="file content here"
To edit a file: @editFile @name="path/to/file" @content="updated content here"
To delete a file: @deleteFile @name="path/to/file"

When the user asks you to create, edit, or delete files:
1. Output the appropriate command(s) using the syntax above
2. Provide a brief explanation of what you're doing
3. Wait for user approval before changes are made

Repository Context:
- Owner: ${owner}
- Repository: ${repo}

Always ensure commands are properly formatted and complete.`;

    const response = await groq.messages.create({
      model: modelMap[model] || 'llama-3.3b-versatile',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: message,
        },
      ],
    });

    const content = response.content[0].text;

    // Extract commands from response
    const commands = [];
    const createRegex = /@createFile\s+@name="([^"]+)"\s+@content="([^"]+)"/g;
    const editRegex = /@editFile\s+@name="([^"]+)"\s+@content="([^"]+)"/g;
    const deleteRegex = /@deleteFile\s+@name="([^"]+)"/g;

    let match;
    while ((match = createRegex.exec(content)) !== null) {
      commands.push({ type: 'create', name: match[1], content: match[2] });
    }
    while ((match = editRegex.exec(content)) !== null) {
      commands.push({ type: 'edit', name: match[1], content: match[2] });
    }
    while ((match = deleteRegex.exec(content)) !== null) {
      commands.push({ type: 'delete', name: match[1] });
    }

    res.json({
      response: content,
      commands,
      model,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to process agent request' });
  }
});

// API: Approve agent commands
app.post('/api/agent/approve', isAuthenticated, async (req, res) => {
  try {
    const { commands, owner, repo } = req.body;

    for (const cmd of commands) {
      if (cmd.type === 'create') {
        await axios.put(
          `https://api.github.com/repos/${owner}/${repo}/contents/${cmd.name}`,
          {
            message: `Create ${cmd.name} via CreateAgent`,
            content: Buffer.from(cmd.content).toString('base64'),
          },
          {
            headers: { Authorization: `token ${req.user.accessToken}` },
          }
        );
      } else if (cmd.type === 'edit') {
        const getResponse = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/contents/${cmd.name}`,
          {
            headers: { Authorization: `token ${req.user.accessToken}` },
          }
        );

        await axios.put(
          `https://api.github.com/repos/${owner}/${repo}/contents/${cmd.name}`,
          {
            message: `Edit ${cmd.name} via CreateAgent`,
            content: Buffer.from(cmd.content).toString('base64'),
            sha: getResponse.data.sha,
          },
          {
            headers: { Authorization: `token ${req.user.accessToken}` },
          }
        );
      } else if (cmd.type === 'delete') {
        const getResponse = await axios.get(
          `https://api.github.com/repos/${owner}/${repo}/contents/${cmd.name}`,
          {
            headers: { Authorization: `token ${req.user.accessToken}` },
          }
        );

        await axios.delete(
          `https://api.github.com/repos/${owner}/${repo}/contents/${cmd.name}`,
          {
            data: {
              message: `Delete ${cmd.name} via CreateAgent`,
              sha: getResponse.data.sha,
            },
            headers: { Authorization: `token ${req.user.accessToken}` },
          }
        );
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to approve commands' });
  }
});

app.listen(PORT, () => {
  console.log(`Divine Create running on http://localhost:${PORT}`);
});
