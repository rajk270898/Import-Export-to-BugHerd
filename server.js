require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const axios = require('axios');
const csv = require('csv-parser');
const xlsx = require('xlsx');
const fs = require('fs');
const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || 
        file.mimetype === 'application/vnd.ms-excel' || 
        file.mimetype === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and Excel files are allowed'));
    }
  }
});

// BugHerd API configuration
const BUGHERD_API_BASE = 'https://www.bugherd.com/api_v2';
const BUGHERD_API_KEY = process.env.BUGHERD_API_KEY;

if (!BUGHERD_API_KEY) {
  console.error('ERROR: BUGHERD_API_KEY is not set in .env file');
  process.exit(1);
}

// Create axios instance for BugHerd API
const bugherdApi = axios.create({
  baseURL: BUGHERD_API_BASE,
  auth: {
    username: BUGHERD_API_KEY,
    password: 'x' // BugHerd API requires a non-empty password
  },
  headers: {
    'Accept': 'application/json'
  }
});

// Helper function to handle API errors
const handleApiError = (error, res) => {
  console.error('API Error:', error.response?.data || error.message);
  const status = error.response?.status || 500;
  const message = error.response?.data?.message || 'An error occurred while processing your request';
  res.status(status).json({ error: message });
};

// Get all projects
app.get('/api/projects', async (req, res) => {
  try {
    console.log('Fetching projects from BugHerd API...');
    console.log('Using API Key:', BUGHERD_API_KEY ? '***' + BUGHERD_API_KEY.slice(-4) : 'Not set');
    
    console.log('Making request to BugHerd API...');
    const response = await bugherdApi.get('/projects.json');
    
    console.log('BugHerd API response status:', response.status);
    console.log('Response headers:', JSON.stringify(response.headers, null, 2));
    console.log('Response data type:', typeof response.data);
    console.log('Response data keys:', Object.keys(response.data || {}));
    
    // Check if the response has the expected format
    let projects = [];
    if (Array.isArray(response.data)) {
      projects = response.data;
    } else if (response.data && Array.isArray(response.data.projects)) {
      projects = response.data.projects;
    } else {
      console.error('Unexpected API response format:', JSON.stringify(response.data, null, 2));
      return res.status(500).json({
        success: false,
        error: 'Unexpected API response format',
        details: response.data
      });
    }
    
    console.log(`Found ${projects.length} projects`);
    res.json({
      success: true,
      projects: projects
    });
  } catch (error) {
    console.error('Error fetching projects:', error.message);
    console.error('Error details:', {
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data
    });
    
    if (error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Invalid BugHerd API key. Please check your .env file and ensure BUGHERD_API_KEY is set correctly.'
      });
    }
    
    handleApiError(error, res);
  }
});

// Parse CSV file
const parseCSV = (filePath) => {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv())
      .on('data', (data) => results.push(data))
      .on('end', () => resolve(results))
      .on('error', reject);
  });
};

// Parse Excel file
const parseExcel = (filePath) => {
  const workbook = xlsx.readFile(filePath);
  const sheetName = workbook.SheetNames[0];
  return xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);
};

// Upload and process file
app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!req.body.projectId) {
      return res.status(400).json({ error: 'Project ID is required' });
    }

    const filePath = req.file.path;
    const fileExt = path.extname(req.file.originalname).toLowerCase();
    let bugs = [];

    try {
      // Parse the uploaded file based on its extension
      if (fileExt === '.csv') {
        bugs = await parseCSV(filePath);
      } else if (['.xlsx', '.xls'].includes(fileExt)) {
        bugs = parseExcel(filePath);
      } else {
        throw new Error('Unsupported file format');
      }

      // Process each bug and create in BugHerd
      const results = [];
      for (const bug of bugs) {
        try {
          // Map CSV fields to BugHerd API fields
          const bugData = {
            description: bug.description || '',
            priority: bug.priority_id ? parseInt(bug.priority_id) : 1, // Default to normal priority
            status: bug.status || 'backlog',
            tag_names: bug.tags ? bug.tags.split(',').map(tag => tag.trim()) : [],
            requester_email: 'support@example.com', // Default email, can be customized
            requester_name: 'CSV Importer',
            browser: bug.browser || '',
            browser_version: '',
            os: bug.os || '',
            resolution: bug.resolution || '',
            site_page: bug.site || ''
          };

          // Create bug in BugHerd
          const response = await bugherdApi.post(
            `/projects/${req.body.projectId}/tasks.json`,
            { task: bugData }
          );

          results.push({
            id: bug.id,
            status: 'success',
            bugherdId: response.data.id,
            url: response.data.url
          });
        } catch (error) {
          console.error(`Error creating bug ${bug.id}:`, error.message);
          results.push({
            id: bug.id,
            status: 'error',
            error: error.message
          });
        }
      }

      // Clean up the uploaded file
      fs.unlinkSync(filePath);

      res.json({
        success: true,
        total: bugs.length,
        results
      });
    } catch (error) {
      // Clean up the uploaded file in case of error
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      throw error;
    }
  } catch (error) {
    handleApiError(error, res);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: err.message || 'Internal server error' 
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
