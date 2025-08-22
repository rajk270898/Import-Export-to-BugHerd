const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
require('dotenv').config();

class ReportGenerator {
    constructor() {
        this.templatePath = path.join(__dirname, 'New template.html');
        this.outputPath = path.join(__dirname, 'generated-report.html');
        this.apiBaseUrl = 'https://www.bugherd.com/api_v2';
        this.apiKey = process.env.BUGHERD_API_KEY;
        
        if (!this.apiKey) {
            console.error('Error: BUGHERD_API_KEY environment variable is not set');
            process.exit(1);
        }
    }

    async generateReport(projectId, filters = {}) {
        try {
            
            // Step 1: Fetch project data
            const project = await this.fetchProject(projectId);
            if (!project) {
                throw new Error('Failed to fetch project data');
            }
            
            // Step 2: Fetch tasks with filters
            let tasks = await this.fetchTasks(projectId);
            
            // Apply filters if any
            if (Object.keys(filters).length > 0) {
                tasks = this.filterTasks(tasks, filters);
            }
            
            if (tasks.length === 0) {
                console.warn('Warning: No tasks found matching the specified filters.');
            } else {
                console.log(`Found ${tasks.length} tasks after applying filters`);
            }
            
            // Step 3: Generate charts
            console.log('Generating charts...');
            const charts = await this.generateCharts(tasks);
            
            // Step 4: Render HTML
            console.log('Rendering HTML...');
            const html = await this.renderHtml(project, tasks, charts);
            
            console.log('Report generated successfully in memory');
            return html;
        } catch (error) {
            console.error('Error generating report:');
            
            if (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN') {
                console.error('Network error: Could not resolve the BugHerd API hostname.');
                console.error('Please check your internet connection and ensure you can access api.bugherd.com');
                console.error('You can test the connection by running:');
                console.error('  ping api.bugherd.com');
                console.error('or');
                console.error('  curl -v https://api.bugherd.com');
            } else if (error.response) {
                // The request was made and the server responded with a status code
                console.error(`API Error: ${error.response.status} - ${error.response.statusText}`);
                console.error('Response data:', error.response.data);
            } else if (error.request) {
                // The request was made but no response was received
                console.error('No response received from the BugHerd API.');
                console.error('This could be due to network issues or the API being unavailable.');
            } else {
                // Something happened in setting up the request
                console.error('Request setup error:', error.message);
            }
            
            console.error('\nTroubleshooting steps:');
            console.error('1. Check your internet connection');
            console.error('2. Verify api.bugherd.com is accessible from your network');
            console.error('3. Ensure your API key in .env is correct');
            console.error('4. Check if there are any network restrictions or proxy settings');
            
            process.exit(1);
        }
    }

    async fetchProject(projectId) {
        console.log(`Fetching project ${projectId} from ${this.apiBaseUrl}`);
        try {
            const response = await axios.get(`${this.apiBaseUrl}/projects/${projectId}.json`, {
                auth: {
                    username: this.apiKey,
                    password: 'x' // BugHerd requires a non-empty password
                },
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                timeout: 10000 // 10 seconds timeout
            });
            console.log('Project data received');
            return response.data.project;
        } catch (error) {
            console.error('Error fetching project:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response data:', error.response.data);
            }
            throw error;
        }
    }

    async fetchTasks(projectId) {
        console.log(`Fetching tasks for project ${projectId}`);
        
        try {
            console.log('Trying API with Basic Auth...');
            const url = `${this.apiBaseUrl}/projects/${projectId}/tasks.json`;
            
            console.log('Request URL:', url);
            
            // First, try to get project info to verify the project exists
            try {
                console.log('Fetching project info...');
                const projectUrl = `${this.apiBaseUrl}/projects/${projectId}.json`;
                const projectResponse = await axios.get(projectUrl, {
                    auth: {
                        username: this.apiKey,
                        password: 'x'
                    },
                    headers: {
                        'Accept': 'application/json'
                    },
                    timeout: 10000
                });
                console.log('Project info:', {
                    id: projectResponse.data?.project?.id,
                    name: projectResponse.data?.project?.name,
                    tasks_count: projectResponse.data?.project?.tasks_count
                });
            } catch (projectError) {
                console.error('Failed to fetch project info:', projectError.message);
                if (projectError.response) {
                    console.error('Response status:', projectError.response.status);
                    console.error('Response data:', projectError.response.data);
                }
                throw new Error('Failed to verify project');
            }

            // Now fetch all tasks with pagination, matching the CSV export approach
            console.log('Fetching tasks with pagination...');
            const allTasks = [];
            const perPage = 50; // Reduced from 100 to avoid timeouts
            let currentPage = 1;
            let hasMorePages = true;
            
            while (hasMorePages) {
                console.log(`Fetching page ${currentPage}...`);
                const response = await axios.get(url, {
                    params: {
                        include: 'attachments',
                        per_page: perPage,
                        page: currentPage
                    },
                    auth: {
                        username: this.apiKey,
                        password: 'x'
                    },
                    headers: {
                        'Accept': 'application/json'
                    },
                    timeout: 60000 // Increased timeout
                });
                
                console.log(`Page ${currentPage} response status:`, response.status);
                
                let pageTasks = [];
                if (response.data?.tasks) {
                    pageTasks = response.data.tasks;
                } else if (Array.isArray(response.data)) {
                    pageTasks = response.data;
                }
                
                console.log(`Found ${pageTasks.length} tasks on page ${currentPage}`);
                
                // Fetch detailed information for each task in this page
                if (pageTasks.length > 0) {
                    console.log(`Fetching detailed info for ${pageTasks.length} tasks...`);
                    const detailedTasks = await this.fetchDetailedTasks(projectId, pageTasks);
                    allTasks.push(...detailedTasks);
                }
                
                if (pageTasks.length < perPage) {
                    hasMorePages = false;
                } else {
                    currentPage++;
                    // Increased delay to avoid rate limiting
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
            console.log(`Total tasks with details fetched: ${allTasks.length}`);
            if (allTasks.length === 0) {
                console.log('No tasks found in the response.');
                
                // Try a direct API call for debugging
                try {
                    const directUrl = `https://www.bugherd.com/api_v2/projects/${projectId}/tasks.json?key=${this.apiKey}`;
                    console.log('Attempting direct API call for debugging...');
                    console.log('Direct URL:', directUrl);
                    
                    const directResponse = await axios.get(directUrl, {
                        headers: {
                            'Accept': 'application/json'
                        },
                        timeout: 10000
                    });
                    
                    console.log('Direct API response:', {
                        status: directResponse.status,
                        statusText: directResponse.statusText,
                        data: directResponse.data ? 'Data received' : 'No data',
                        tasksCount: directResponse.data?.tasks?.length || 0
                    });
                } catch (directError) {
                    console.error('Direct API call failed:', directError.message);
                }
            }
            
            return allTasks;
            
        } catch (error) {
            console.error('Error in fetchTasks:', error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                console.error('Response headers:', error.response.headers);
                if (error.response.data) {
                    console.error('Response data:', JSON.stringify(error.response.data, null, 2));
                }
            } else if (error.request) {
                console.error('No response received. This could be due to:');
                console.error('1. Network connectivity issues');
                console.error('2. CORS restrictions');
                console.error('3. Server not responding');
                console.error('Request details:', error.request);
            } else {
                console.error('Request setup error:', error.message);
            }
            
            // Return empty array instead of throwing to allow the report to be generated
            return [];
        }
    }
    
    /**
     * Filter tasks based on the provided filters
     * @param {Array} tasks - Array of tasks to filter
     * @param {Object} filters - Filters to apply
     * @returns {Array} Filtered array of tasks
     */
    filterTasks(tasks, filters) {
        if (!tasks || !Array.isArray(tasks)) {
            console.warn('No tasks provided for filtering');
            return [];
        }

        console.log(`\n=== Applying Filters ===`);
        console.log('Active filters:', JSON.stringify(filters, null, 2));
        console.log(`Total tasks before filtering: ${tasks.length}`);
        
        // Count how many filters are active
        const activeFilters = Object.values(filters).filter(v => v !== undefined).length;
        
        const filtered = tasks.filter(task => {
            console.log('\n--- Processing Task ---');
            console.log('Task ID:', task.id);
            console.log('Status:', task.status);
            console.log('Has column_id:', !!task.column_id);
            
            let matchesAnyFilter = activeFilters === 0; // If no filters, include all tasks
            let matchesAllFilters = true;
            let matchDetails = [];
            
            // Check archive filter
            if (filters.archive !== undefined) {
                const status = task.status?.name || task.status || '';
                const statusLower = status.toLowerCase();
                const isArchived = statusLower === 'closed' || statusLower === 'resolved' || statusLower === 'archived';
                const archiveMatch = (filters.archive && isArchived) || (!filters.archive && !isArchived);
                
                matchDetails.push(`Archive: ${archiveMatch ? '✅' : '❌'}`);
                matchesAnyFilter = matchesAnyFilter || (filters.archive && isArchived);
                matchesAllFilters = matchesAllFilters && archiveMatch;
            }
            
            // Check task board filter
            if (filters.taskBoard !== undefined) {
                const hasColumn = !!task.column_id;
                const taskBoardMatch = (filters.taskBoard && hasColumn) || (!filters.taskBoard && !hasColumn);
                
                matchDetails.push(`Task Board: ${taskBoardMatch ? '✅' : '❌'}`);
                matchesAnyFilter = matchesAnyFilter || (filters.taskBoard && hasColumn);
                matchesAllFilters = matchesAllFilters && taskBoardMatch;
            }
            
            // Check feedback filter (assuming feedback tasks have type 'feedback' or similar)
            if (filters.feedback !== undefined) {
                const isFeedback = task.type === 'feedback' || 
                                 (task.tags && task.tags.some(tag => 
                                     typeof tag === 'string' ? 
                                     tag.toLowerCase().includes('feedback') : 
                                     tag.name?.toLowerCase().includes('feedback')
                                 ));
                const feedbackMatch = (filters.feedback && isFeedback) || (!filters.feedback && !isFeedback);
                
                matchDetails.push(`Feedback: ${feedbackMatch ? '✅' : '❌'}`);
                matchesAnyFilter = matchesAnyFilter || (filters.feedback && isFeedback);
                matchesAllFilters = matchesAllFilters && feedbackMatch;
            }
            
            // Always use OR logic between different filter types when they are true
            const shouldInclude = matchesAnyFilter;
            
            console.log('Match Details:', matchDetails.join(' | '));
            console.log(`Result: ${shouldInclude ? '✅ INCLUDED' : '❌ FILTERED OUT'}`);
            
            return shouldInclude;
        });

        console.log(`\n=== Filtering Complete ===`);
        console.log(`Total tasks after filtering: ${filtered.length} of ${tasks.length}`);
        return filtered;
    }

    async generateCharts(tasks) {
        const width = 400;
        const height = 400;
        const chartJSNodeCanvas = new ChartJSNodeCanvas({ width, height });

        // Generate data for severity chart
        const severityData = this.getSeverityData(tasks);
        const severityConfig = this.getSeverityChartConfig(severityData);
        const severityChart = await chartJSNodeCanvas.renderToBuffer(severityConfig);

        // Generate data for status chart
        const statusData = this.getStatusData(tasks);
        const statusConfig = this.getStatusChartConfig(statusData);
        const statusChart = await chartJSNodeCanvas.renderToBuffer(statusConfig);

        return {
            severity: severityChart.toString('base64'),
            status: statusChart.toString('base64')
        };
    }

    getSeverityData(tasks) {
        const severityCounts = {
            critical: 0,
            major: 0,
            minor: 0,
            enhancement: 0
        };

        tasks.forEach(task => {
            const priority = (task.priority || '').toLowerCase();
            if (severityCounts.hasOwnProperty(priority)) {
                severityCounts[priority]++;
            } else {
                severityCounts.minor++; // Default to minor if priority not recognized
            }
        });

        return {
            labels: ['Critical', 'Major', 'Minor', 'Enhancement'],
            data: Object.values(severityCounts),
            colors: ['#EF4444', '#F59E0B', '#10B981', '#3B82F6']
        };
    }

    getStatusData(tasks) {
        const statusMap = {};
        
        tasks.forEach(task => {
            const status = task.status?.name || 'Unknown';
            statusMap[status] = (statusMap[status] || 0) + 1;
        });

        return {
            labels: Object.keys(statusMap),
            data: Object.values(statusMap),
            colors: this.generateColors(Object.keys(statusMap).length)
        };
    }

    generateColors(count) {
        const colors = [];
        const hueStep = 360 / count;
        
        for (let i = 0; i < count; i++) {
            const hue = (i * hueStep) % 360;
            colors.push(`hsl(${hue}, 70%, 60%)`);
        }
        
        return colors;
    }

    getSeverityChartConfig(data) {
        return {
            type: 'doughnut',
            data: {
                labels: data.labels,
                datasets: [{
                    data: data.data,
                    backgroundColor: data.colors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'bottom',
                        labels: {
                            font: {
                                family: 'Outfit, sans-serif'
                            }
                        }
                    }
                },
                cutout: '70%'
            }
        };
    }

    getStatusChartConfig(data) {
        return {
            type: 'pie',
            data: {
                labels: data.labels,
                datasets: [{
                    data: data.data,
                    backgroundColor: data.colors,
                    borderWidth: 0
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        display: false
                    }
                },
                cutout: '60%'
            }
        };
    }

    /**
     * Fetches detailed information for each task in the list
     * @param {string} projectId - The project ID
     * @param {Array} tasks - Array of basic task objects
     * @returns {Promise<Array>} Array of detailed task objects
     */
    async fetchDetailedTasks(projectId, tasks) {
        console.log(`Fetching detailed info for ${tasks.length} tasks...`);
        
        const detailedTasks = [];
        
        // Process tasks in batches to avoid overwhelming the API
        const batchSize = 5;
        for (let i = 0; i < tasks.length; i += batchSize) {
            const batch = tasks.slice(i, i + batchSize);
            const batchPromises = batch.map(task => 
                this.fetchTaskDetails(projectId, task.id)
                    .then(details => ({
                        ...task,
                        ...details // Merge basic task data with detailed data
                    }))
                    .catch(error => {
                        console.error(`Error fetching details for task ${task.id}:`, error.message);
                        return task; // Return original task if details fetch fails
                    })
            );
            
            const batchResults = await Promise.all(batchPromises);
            detailedTasks.push(...batchResults);
            
            // Add delay between batches to avoid rate limiting
            if (i + batchSize < tasks.length) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        console.log(`Fetched details for ${detailedTasks.length} tasks`);
        return detailedTasks;
    }
    
    /**
     * Fetches detailed information for a single task
     * @param {string} projectId - The project ID
     * @param {string} taskId - The task ID
     * @returns {Promise<Object>} Detailed task information
     */
    async fetchTaskDetails(projectId, taskId) {
        const url = `${this.apiBaseUrl}/projects/${projectId}/tasks/${taskId}.json`;
        
        try {
            const response = await axios.get(url, {
                auth: {
                    username: this.apiKey,
                    password: 'x'
                },
                headers: {
                    'Accept': 'application/json'
                },
                timeout: 30000
            });
            
            // The detailed task data might be in response.data or response.data.task
            return response.data?.task || response.data || {};
        } catch (error) {
            console.error(`Error fetching details for task ${taskId}:`, error.message);
            if (error.response) {
                console.error('Response status:', error.response.status);
                if (error.response.status === 404) {
                    console.error(`Task ${taskId} not found`);
                }
            }
            return {}; // Return empty object if details can't be fetched
        }
    }

    async renderHtml(project, tasks, charts) {
        // Read the template file
        let html = fs.readFileSync(this.templatePath, 'utf8');
        
        // Format the current date
        const currentDate = new Date().toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });

        // Prepare bug data with all required fields matching the CSV export format
        const bugData = tasks.map((task, index) => {
            // Helper function to safely get values
            const getValue = (value, defaultValue = '') => {
                if (value === null || value === undefined) return defaultValue;
                if (Array.isArray(value)) return value.join(', ');
                return String(value).trim() || defaultValue;
            };

            // Helper: Deep-search the task object for the first plausible http(s) URL
            const findFirstUrlDeep = (obj) => {
                const seen = new Set();
                const stack = [obj];
                const urlLike = /https?:\/\//i;
                while (stack.length) {
                    const cur = stack.pop();
                    if (!cur || typeof cur !== 'object') continue;
                    if (seen.has(cur)) continue;
                    seen.add(cur);
                    for (const [k, v] of Object.entries(cur)) {
                        if (v && typeof v === 'string') {
                            const s = v.trim();
                            if (urlLike.test(s)) {
                                // Strip surrounding quotes/brackets and trailing punctuations
                                const cleaned = s
                                    .replace(/^['"\[\(\{]+|['"\]\)\}]+$/g, '')
                                    .replace(/[\s,;]+$/, '')
                                    .replace(/[\])}>\)"']*$/, '');
                                // Validate
                                try { new URL(cleaned); return cleaned; } catch (_) {}
                            }
                        } else if (v && typeof v === 'object') {
                            stack.push(v);
                        }
                        // Also consider keys that look like page_url/url
                        if ((/page_url|url/i).test(k) && typeof v === 'string' && urlLike.test(v)) {
                            try { new URL(v); return v; } catch (_) {}
                        }
                    }
                }
                return '';
            };

            // Extract status and type
            const status = getValue(task.status?.name || task.status);
            const bugType = status && status.toLowerCase() === 'suggestion' ? 'Suggestion' : 
                          (status && status.toLowerCase() === 'qa team' ? 'Bug' : status);
            
            // Extract priority
            const priorityMap = {
                1: 'Critical',
                2: 'Important',
                3: 'Normal',
                4: 'Minor',
                0: 'Not Set'
            };
            const priority = task.priority_id !== undefined ? 
                priorityMap[task.priority_id] || 'Normal' : 'Normal';
            
            // Extract description and environment info
            const rawDescription = getValue(task.description);
            const env = this.extractEnvFromDescription(rawDescription);
            
            // Extract tags
            const tags = task.tag_names ? 
                (Array.isArray(task.tag_names) ? task.tag_names.join(', ') : task.tag_names) : 
                (task.tags ? (Array.isArray(task.tags) ? task.tags.join(', ') : task.tags) : '');
            
            // Extract URL - match CSV export logic from server.js exactly
            let siteUrl = '';
            let pageUrlRaw = '';
            
            // Check URL fields in order of preference based on BugHerd API response
            const possibleUrlFields = [
                // Prefer page-level URLs with path and query first
                task.page_url,
                task.attributes?.page_url,
                task.attributes?.url,
                task.meta?.url,
                task.url,                     // Direct URL from BugHerd
                task.site_url,                // Alternative URL field
                // Last-resort hints
                task.screenshot_url,
                task.screenshot
            ];
            
            // Also check in attachments for URL
            if (Array.isArray(task.attachments)) {
                for (const att of task.attachments) {
                    if (att.url && att.url.includes('http')) {
                        possibleUrlFields.push(att.url);
                    }
                }
            }
            
            // Try to extract from description
            const urlRegex = /(?:https?:\/\/|www\.)[^\s\n\)\]\}'">]+/gi;
            const urlsInDescription = (rawDescription || '').match(urlRegex) || [];
            
            // Combine all possible URL sources
            const allUrlSources = [...possibleUrlFields, ...urlsInDescription];
            
            // Find the first valid URL
            for (const url of allUrlSources) {
                if (!url) continue;
                
                let cleanUrl = String(url)
                    .trim()
                    .replace(/^['"]+|['"]+$/g, '')  // Remove surrounding quotes
                    .replace(/[\s,;]+$/, '')         // Remove trailing whitespace and common punctuation
                    .replace(/[\])}>)"']*$/, '');    // Remove trailing brackets/quotes
                
                if (!cleanUrl) continue;
                
                // Ensure URL has protocol
                if (!/^https?:\/\//i.test(cleanUrl) && /^[^\s:]+\.[^\s.]+/.test(cleanUrl)) {
                    cleanUrl = 'https://' + cleanUrl.replace(/^\/\//, '');
                }
                
                try {
                    // Try to create URL object to validate
                    new URL(cleanUrl);
                    siteUrl = cleanUrl;
                    pageUrlRaw = cleanUrl;
                    break; // Use the first valid URL we find
                } catch (e) {
                    // Not a valid URL, continue to next candidate
                    continue;
                }
            }

            // If still no URL, deep-search the task object
            if (!siteUrl) {
                const deepUrl = findFirstUrlDeep(task);
                if (deepUrl) {
                    try {
                        const validated = new URL(deepUrl).toString();
                        siteUrl = validated;
                        pageUrlRaw = validated;
                    } catch (_) {}
                }
            }

            // If BugHerd provided domain separately and path in url/page_url, compose them
            {
                const candidatePaths = [task.url, task.page_url, task.attributes?.page_url, task.attributes?.url];
                const baseSiteRaw = (task.site || '').toString().trim();
                const rel = candidatePaths.find(p => typeof p === 'string' && p.trim().startsWith('/'));
                if (baseSiteRaw && rel) {
                    try {
                        const base = baseSiteRaw.match(/^https?:\/\//) ? baseSiteRaw : `https://${baseSiteRaw}`;
                        const composedUrl = new URL(rel, base);
                        const composed = composedUrl.toString();
                        const baseUrlObj = new URL(base);
                        const isScreenshot = (u) => /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)($|[?#])/i.test(u) || /files\.bugherd\.com/i.test(u);
                        const isBaseOnly = (u) => {
                            try { const o = new URL(u); return (o.hostname === baseUrlObj.hostname) && (o.pathname === '/' || o.pathname === ''); } catch { return false; }
                        };
                        // Always use composed full URL for grouping/display
                        pageUrlRaw = composed;
                        // Replace siteUrl if it's empty, a screenshot, or just the base domain
                        if (!siteUrl || isScreenshot(siteUrl) || isBaseOnly(siteUrl)) {
                            siteUrl = composed;
                        }
                    } catch (_) {}
                }
            }
            
            // Build siteDisplay exactly like server.js (combine Site + URL cleanly)
            // Get the site value from task.site if available, otherwise extract domain from siteUrl
            let site = (task.site || '').toString().trim();
            
            // If site is empty but we have a siteUrl, derive site from it
            if ((!site || site === '') && siteUrl) {
                try {
                    // Ensure the URL has a protocol
                    const fullUrl = siteUrl.match(/^https?:\/\//) ? siteUrl : `https://${siteUrl}`;
                    const url = new URL(fullUrl);
                    // Keep the full URL with protocol but only protocol + host (+port)
                    site = `${url.protocol}//${url.hostname}${url.port ? ':' + url.port : ''}`;
                } catch (e) {
                    // If URL parsing fails, fallback to siteUrl
                    site = siteUrl;
                }
            }

            // Format siteDisplay: prefer full URL (with query) when available; otherwise fall back to site
            let siteDisplay = '';
            let cleanSite = site || '';
            let cleanUrl = pageUrlRaw || siteUrl || '';

            // Normalize: remove protocol from site; ensure URL has protocol
            cleanSite = cleanSite.replace(/^https?:\/\//, '');
            if (cleanUrl && !/^https?:\/\//i.test(cleanUrl)) {
                cleanUrl = `https://${cleanUrl}`;
            }

            // Always use the full URL (with path and query) if present
            if (cleanUrl) {
                siteDisplay = cleanUrl;
            } else if (cleanSite) {
                siteDisplay = cleanSite;
            } else {
                siteDisplay = '';
            }

            // Compute siteGroup for grouping by domain (hostname[:port])
            // Use the derived `site` (protocol + host) when available, otherwise derive from cleanUrl
            let siteGroup = '';
            try {
                if (site) {
                    // site is protocol + host[:port]; strip protocol for grouping key
                    siteGroup = site.replace(/^https?:\/\//i, '');
                } else if (cleanUrl) {
                    const u = new URL(cleanUrl);
                    siteGroup = `${u.hostname}${u.port ? ':' + u.port : ''}`;
                }
            } catch (e) {
                // Fallback: try to salvage a hostname-like value
                siteGroup = (cleanSite || cleanUrl || '').replace(/^https?:\/\//i, '');
            }
            
            // Extract screenshot URL
            let screenshot = '';
            // 1) Prefer explicit endpoint fields
            if (task.screenshot_url) screenshot = task.screenshot_url;
            else if (task.screenshot) screenshot = task.screenshot;
            else if (task.attachments && task.attachments.length > 0) {
                // Try to get the first image attachment
                const imageAttachment = task.attachments.find(att => 
                    att.content_type && att.content_type.startsWith('image/')
                );
                if (imageAttachment) {
                    screenshot = imageAttachment.url || '';
                }
            }
            // 2) Fallback to parsing from description using 'Screenshot:'
            if (!screenshot) {
                const fromDesc = this.extractScreenshotFromDescription(rawDescription);
                if (fromDesc) screenshot = fromDesc;
            }
            // 3) Last resort text
            if (!screenshot) screenshot = 'No Screenshot found';
            
            // Extract reporter/requester
            const reporter = getValue(task.requester_email || task.reporter);
            
            // Debug log the URL data
            console.log(`[DEBUG] Task ${index + 1}:`);
            console.log(`- siteUrl: ${siteUrl}`);
            console.log(`- pageUrlRaw: ${pageUrlRaw}`);
            console.log(`- siteDisplay: ${siteDisplay}`);
            
            // Return data in the same format as CSV export
            const bugData = {
                id: index + 1, // BugID is 1-based index
                bugStatus: 'New',
                bugType: bugType,
                priority: priority,
                priorityId: task.priority_id || '',
                description: rawDescription,
                tags: tags,
                siteUrl: siteUrl,
                siteDisplay: siteDisplay, // Add the combined site display URL
                pageUrlRaw: pageUrlRaw, // Raw full URL detected anywhere in the task
                siteGroup: siteGroup, // Domain-only key used for grouping in the UI
                os: env.os,
                browser: env.browser,
                browserSize: env.browserWindow,
                resolution: env.resolution,
                screenshot: screenshot,
                reporter: reporter,
                severity: priority, // Using same as priority for now
                tagsCategories: tags, // Same as tags for now
                element: 'Not specified',
                assignee: task.assignee_email || 'Unassigned',
                comments: task.comments_count || 0,
                // Keep original fields for backward compatibility
                title: `Task ${index + 1}`,
                status: status,
                created_at: task.created_at || new Date().toISOString(),
                updated_at: task.updated_at || new Date().toISOString()
            };
            
            console.log(`[DEBUG] Bug data for task ${index + 1}:`, JSON.stringify(bugData, null, 2));
            return bugData;
        });

        // Debug: Log the first task to verify the structure
        if (bugData.length > 0) {
            console.log('First task data:', JSON.stringify(bugData[0], null, 2));
        }

        // Inject the bug data as a JavaScript variable
        const bugDataScript = `
            <script>
                // Store the tasks data in a global variable
                window.bugData = ${JSON.stringify(bugData, null, 2)};
                
                // Debug: Log the data to console
                console.log('Bug data loaded:', window.bugData);
            </script>
        `;
        
        // Inject the bug data script before the closing head tag
        html = html.replace('</head>', `${bugDataScript}</head>`);
        
        // Update the report title with project name and date
        const reportTitle = `Bug Report - ${project.name || 'Project'} - ${currentDate}`;
        html = html.replace('<title>Sample Font Style Report</title>', `<title>${reportTitle}</title>`);
        
        // Update the report title in the header
        const reportTitleRegex = /<span\s+class=["']report-title["']>.*?<\/span>/i;
        html = html.replace(reportTitleRegex, `<span class="report-title">${reportTitle}</span>`);
        
        // Prepare the charts initialization script
        const chartsScript = `
            <script>
                document.addEventListener('DOMContentLoaded', function() {
                    // Initialize the UI with the new template's functions
                    if (window.bugData && window.bugData.length > 0) {
                        // Initialize the charts
                        const severityCtx = document.getElementById('severityChart').getContext('2d');
                        window.severityChart = new Chart(severityCtx, {
                            type: 'pie',
                            data: {
                                labels: ['Critical', 'Important', 'Normal', 'Minor', 'Not Set'],
                                datasets: [{
                                    data: [
                                        window.bugData.filter(b => b.priority === 'critical').length,
                                        window.bugData.filter(b => b.priority === 'important').length,
                                        window.bugData.filter(b => b.priority === 'normal').length,
                                        window.bugData.filter(b => b.priority === 'minor').length,
                                        window.bugData.filter(b => !b.priority || b.priority === 'not set').length
                                    ],
                                    backgroundColor: [
                                        '#EF4444', // Critical - Red
                                        '#F59E0B', // Important - Amber
                                        '#3B82F6', // Normal - Blue
                                        '#6B7280', // Minor - Gray
                                        '#E5E7EB'  // Not Set - Light Gray
                                    ],
                                    borderWidth: 0
                                }]
                            },
                            options: {
                                responsive: true,
                                maintainAspectRatio: false,
                                plugins: {
                                    legend: {
                                        position: 'bottom',
                                        labels: {
                                            font: {
                                                family: 'Outfit, sans-serif'
                                            },
                                            padding: 20
                                        }
                                    }
                                },
                                cutout: '70%',
                                onClick: function(evt, elements) {
                                    if (elements.length > 0) {
                                        const index = elements[0].index;
                                        const labels = this.data.labels;
                                        const severity = labels[index].toLowerCase();
                                        if (typeof filterIssues === 'function') {
                                            filterIssues(severity === 'not set' ? '' : severity);
                                        }
                                    }
                                }
                            }
                        });

                        // Initialize the UI components
                        if (typeof createIssueCards === 'function') {
                            createIssueCards();
                        }
                        
                        if (typeof initializeAccordion === 'function') {
                            initializeAccordion();
                        }
                        
                        // Show critical issues by default if the function exists
                        if (typeof filterIssues === 'function') {
                            filterIssues('critical');
                            
                            // Update the UI to show the critical filter as active
                            const criticalFilter = document.querySelector('.property-item');
                            if (criticalFilter) {
                                criticalFilter.classList.add('selected');
                            }
                        }
                    } else {
                        // No bugs case
                        const issueList = document.querySelector('.issue-list');
                        if (issueList) {
                            const noIssuesDiv = document.createElement('div');
                            noIssuesDiv.className = 'no-issues';
                            
                            const heading = document.createElement('h3');
                            heading.textContent = 'No issues found';
                            
                            const paragraph = document.createElement('p');
                            paragraph.textContent = 'There are no issues to display for the selected filters.';
                            
                            noIssuesDiv.appendChild(heading);
                            noIssuesDiv.appendChild(paragraph);
                            
                            issueList.innerHTML = '';
                            issueList.appendChild(noIssuesDiv);
                        }
                    }
                });
            </script>
        `;
        
        // Inject the charts script before the closing body tag
        return html.replace('</body>', `${chartsScript}</body>`);
    }
    
    generateTasksHtml(tasks) {
        return tasks.map((task, index) => {
            // Helper function to safely get values
            const getValue = (value, defaultValue = '') => {
                if (value === null || value === undefined) return defaultValue;
                if (Array.isArray(value)) return value.join(', ');
                if (typeof value === 'object') return JSON.stringify(value);
                return String(value).trim();
            };

            // Map priority_id to readable string
            let priority = '';
            const priorityMap = {
                1: 'critical',
                2: 'important',
                3: 'normal',
                4: 'minor',
                0: 'not set',
            };
            
            if (typeof task.priority_id !== 'undefined') {
                priority = priorityMap[task.priority_id] || getValue(task.priority);
            } else {
                priority = getValue(task.priority);
            }

            // Get status with fallback
            const status = task.status?.name || task.status || 'Open';
            
            // Keep raw description for parsing and a HTML version for display
            const rawDescription = getValue(task.description);
            const description = rawDescription.replace(/\n/g, '<br>');
            
            // Extract environment information
            const env = this.extractEnvFromDescription(description);
            
            // Enhanced site URL extraction with comprehensive field checking
            let siteUrl = '';
            
            // Check URL fields in order of preference based on BugHerd API response
            const possibleUrlFields = [
                task.url,                     // Direct URL from BugHerd
                task.site_url,                // Alternative URL field
                task.site,                    // Site field (might contain domain)
                task.page_url,                // Page URL field
                task.page,                    // Page field
                task.site_page,               // Site page field
                task.URL,                     // Uppercase URL field (just in case)
                task['page_url'],             // Alternative syntax
                task['page-url'],             // Kebab case
                task['site-page'],            // Kebab case
                task['site_page']             // Snake case
            ];
            
            // Also check in the task's attributes if they exist
            if (task.attributes && typeof task.attributes === 'object') {
                possibleUrlFields.push(
                    task.attributes.url,
                    task.attributes.page_url,
                    task.attributes.site_url
                );
            }
            
            // Find the first non-empty URL from the possible fields
            for (const url of possibleUrlFields) {
                if (url && typeof url === 'string' && url.trim() !== '') {
                    siteUrl = url.trim();
                    break;
                }
            }
            
            // If no URL found in direct fields, try to extract from description
            if (!siteUrl) {
                const urlRegex = /(?:https?:\/\/|www\.)[^\s\n\)\]\}'">]+/gi;
                const urlsInDescription = (description || '').match(urlRegex) || [];
                if (urlsInDescription.length > 0) {
                    siteUrl = urlsInDescription[0];
                }
            }
            
            // Clean up the URL
            if (siteUrl) {
                siteUrl = siteUrl
                    .replace(/^['"]+|['"]+$/g, '')  // Remove surrounding quotes
                    .replace(/\s+$/, '')             // Remove trailing whitespace
                    .replace(/[\s,;]+$/, '')         // Remove trailing punctuation
                    .replace(/\.$/, '');             // Remove trailing period
                    
                // Ensure URL has protocol
                if (siteUrl && !siteUrl.match(/^https?:\/\//) && siteUrl.match(/^[^\s:]+\.[^\s.]+/)) {
                    siteUrl = 'https://' + siteUrl.replace(/^\/\//, '');
                }
            }
            
            // Get screenshot URL with priority: endpoint -> description -> fallback text
            let screenshot = '';
            if (task.screenshot_url) screenshot = task.screenshot_url;
            else if (task.screenshot) screenshot = task.screenshot;
            else if (task.attachments && task.attachments.length > 0) {
                const imageAttachment = task.attachments.find(att => 
                    att.content_type && att.content_type.startsWith('image/')
                ) || task.attachments[0];
                if (imageAttachment) screenshot = imageAttachment.url || '';
            }
            if (!screenshot) {
                const fromDesc = this.extractScreenshotFromDescription(rawDescription);
                if (fromDesc) screenshot = fromDesc;
            }
            if (!screenshot) screenshot = 'No Screenshot found';
            
            // Get requester email
            const requesterEmail = task.requester_email || 
                                 (task.requester && task.requester.email) || 
                                 (task.reporter && (task.reporter.email || task.reporter.name)) || 
                                 '';
            
            // Format tags
            const tags = Array.isArray(task.tags) 
                ? task.tags.map(tag => typeof tag === 'string' ? tag : tag.name).join(', ')
                : getValue(task.tags);
                
            // Determine bug type based on status
            const bugType = status && status.toLowerCase() === 'suggestion' 
                ? 'Suggestion' 
                : (status && status.toLowerCase() === 'qa team' ? 'Bug' : status);

            // Create data object with property names that match the HTML template
            const taskData = {
                id: index + 1,  // BugID
                bugStatus: 'New',
                bugType: (status && status.toLowerCase() === 'suggestion' ? 'Suggestion' : (status && status.toLowerCase() === 'qa team' ? 'Bug' : status)),
                severity: priority,
                priority: priority,
                priorityId: task.priority_id || '',
                description: description.replace(/<br\s*\/?>/g, '\n'),
                tags: tags,
                siteUrl: siteUrl,  // This must match the template's expected property name
                os: env.os,
                browser: env.browser,
                browserSize: env.browserWindow,
                resolution: env.resolution,
                screenshot: screenshot,  // This must match the template's expected property name
                'Screenshot URL': screenshot,
                reporter: requesterEmail,  // This must match the template's expected property name
            };

            // Generate HTML for the task card
            return `
                <div class="issue-card" 
                     data-severity="${priority}" 
                     data-status="${status.toLowerCase()}"
                     data-id="${task.id || ''}">
                    <div class="issue-header">
                        <span class="issue-id">#${taskData['BugID']}</span>
                        <span class="issue-priority ${priority}">
                            ${priority.charAt(0).toUpperCase() + priority.slice(1)}
                        </span>
                    </div>
                    <div class="issue-description">
                        <strong>Bug Type:</strong> ${taskData['Bug Type']}<br>
                        <strong>Status:</strong> ${taskData['Bug Status']}<br>
                        <strong>Priority:</strong> ${taskData['Priority']} (ID: ${taskData['Priority ID']})<br>
                        <strong>Severity:</strong> ${taskData['Severity']}<br>
                        <strong>Description:</strong> ${taskData['Description'].replace(/\n/g, '<br>')}<br><br>
                        
                        <strong>Environment:</strong>
                        <ul>
                            <li>Site URL: ${taskData['Site URL'] || 'N/A'}</li>
                            <li>OS: ${taskData['OS'] || 'N/A'}</li>
                            <li>Browser: ${taskData['Browser'] || 'N/A'}</li>
                            <li>Browser Size: ${taskData['Browser Size'] || 'N/A'}</li>
                            <li>Resolution: ${taskData['Resolution'] || 'N/A'}</li>
                        </ul>
                        
                        ${taskData['Screenshot URL'] ? 
                            `<strong>Screenshot:</strong> <a href="${taskData['Screenshot URL']}" target="_blank">View Screenshot</a><br>` : ''}
                        
                        <strong>Reporter:</strong> ${taskData['Reporter'] || 'N/A'}<br>
                        <strong>Tags:</strong> ${taskData['Tags'] || 'None'}<br>
                    </div>
                </div>
            `;
        }).join('\n');
    }

    extractEnvFromDescription(desc) {
        if (typeof desc !== 'string') return { os: '', browser: '', resolution: '', browserWindow: '' };
        
        const osMatch = desc.match(/OS\s*:\s*([^\n]+)/i);
        const browserMatch = desc.match(/Browser\s*:\s*([^\n]+)/i);
        const resMatch = desc.match(/Resolution\s*:?\s*([^\n]+)/i);
        const browserWindowMatch = desc.match(/Browser\s*Window\s*:?\s*([^\n]+)/i);
        
        return {
            os: osMatch ? osMatch[1].trim() : '',
            browser: browserMatch ? browserMatch[1].trim() : '',
            resolution: resMatch ? resMatch[1].trim() : '',
            browserWindow: browserWindowMatch ? browserWindowMatch[1].trim() : ''
        };
    }

    /**
     * Extract a screenshot URL from a task description using the label 'Screenshot:'
     * Priority is given to the first valid http(s) URL found on the same line.
     * @param {string} desc
     * @returns {string} URL or empty string
     */
    extractScreenshotFromDescription(desc) {
        if (typeof desc !== 'string') return '';
        // Find a line that starts with or contains 'Screenshot:' and capture the rest of the line
        const m = desc.match(/Screenshot\s*:\s*([^\n\r]+)/i);
        if (!m) return '';
        const line = m[1].trim();
        // From that line, extract the first plausible URL
        const urlMatch = line.match(/https?:\/\/[^\s\]\)>'"}]+/i);
        if (!urlMatch) return '';
        let url = urlMatch[0]
            .replace(/^['"]+|['"]+$/g, '')
            .replace(/[\s,;]+$/, '')
            .replace(/[\])}>"']*$/, '');
        try {
            // Validate URL
            return new URL(url).toString();
        } catch (_) {
            return '';
        }
    }

    generateSummary(tasks) {
        const total = tasks.length;
        const bySeverity = tasks.reduce((acc, task) => {
            const severity = task.priority?.toLowerCase() || 'minor';
            acc[severity] = (acc[severity] || 0) + 1;
            return acc;
        }, {});

        const byStatus = tasks.reduce((acc, task) => {
            const status = task.status?.name || 'Open';
            acc[status] = (acc[status] || 0) + 1;
            return acc;
        }, {});

        return {
            total,
            bySeverity,
            byStatus
        };
    }

    injectSummary(html, summary) {
        // Update total count
        html = html.replace('', summary.total);
        
        // Update severity counts
        Object.entries(summary.bySeverity).forEach(([severity, count]) => {
            html = html.replace(``, count);
        });
        
        // Update status counts
        let statusHtml = '';
        Object.entries(summary.byStatus).forEach(([status, count]) => {
            statusHtml += `
                <div class="status-item">
                    <span class="status-name">${status}:</span>
                    <span class="status-count">${count}</span>
                </div>
            `;
        });
        
        return html.replace('', statusHtml);
    }

}

// Export the class for use in other files
module.exports = ReportGenerator;

// If this file is run directly, execute the report generation
if (require.main === module) {
    const projectId = process.argv[2];
    if (!projectId) {
        console.error('Usage: node generator.js <project-id>');
        process.exit(1);
    }
    
    const generator = new ReportGenerator();
    generator.generateReport(projectId);
}