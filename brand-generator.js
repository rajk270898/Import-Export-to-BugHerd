const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
require('dotenv').config();

class BrandReportGenerator {
    constructor() {
        this.templatePath = path.join(__dirname, 'brand_Template', 'brand-template.html');
        this.outputPath = path.join(__dirname, 'generated-brand-report.html');
        this.apiBaseUrl = 'https://www.bugherd.com/api_v2';
        this.apiKey = process.env.BUGHERD_API_KEY;
        
        if (!this.apiKey) {
            console.error('Error: BUGHERD_API_KEY environment variable is not set');
            process.exit(1);
        }
    }

    async generateReport(projectId, filters = {}) {
        try {
            // Fetch project data
            const project = await this.fetchProject(projectId);
            if (!project) {
                throw new Error('Failed to fetch project data');
            }
            
            // Fetch tasks with filters
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
            
            // Generate the HTML report
            const html = await this.renderHtml(project, tasks);
            
            console.log('Brand report generated successfully');
            return html;
        } catch (error) {
            console.error('Error generating brand report:');
            console.error(error);
            throw error;
        }
    }

    async fetchProject(projectId) {
        console.log(`Fetching project ${projectId} from ${this.apiBaseUrl}`);
        try {
            const response = await axios.get(`${this.apiBaseUrl}/projects/${projectId}.json`, {
                auth: {
                    username: this.apiKey,
                    password: 'x'
                },
                headers: {
                    'Accept': 'application/json',
                    'Authorization': `Bearer ${this.apiKey}`
                },
                timeout: 10000
            });
            console.log('Project data received');
            
            // Log the full project data for debugging
            console.log('Project data from API:', JSON.stringify(response.data, null, 2));
            
            // Ensure the project has a site URL
            if (response.data && !response.data.site) {
                console.warn('No site URL found in project data. Falling back to tasks for site URL.');
            }
            
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
            const url = `${this.apiBaseUrl}/projects/${projectId}/tasks.json`;
            const allTasks = [];
            const perPage = 50;
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
                    timeout: 60000
                });
                
                let pageTasks = [];
                if (response.data?.tasks) {
                    pageTasks = response.data.tasks;
                } else if (Array.isArray(response.data)) {
                    pageTasks = response.data;
                }
                
                if (pageTasks.length === 0) {
                    hasMorePages = false;
                } else {
                    allTasks.push(...pageTasks);
                    currentPage++;
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
            }
            
            console.log(`Total tasks fetched: ${allTasks.length}`);
            return allTasks;
        } catch (error) {
            console.error('Error fetching tasks:', error.message);
            throw error;
        }
    }

    filterTasks(tasks, filters) {
        return tasks.filter(task => {
            // Implement your filtering logic here
            // Similar to the existing filter in generator.js
            return true; // Return true to include all tasks for now
        });
    }

    async renderHtml(project, tasks) {
        try {
            // Read the template file
            let html = await fs.promises.readFile(this.templatePath, 'utf8');
            
            // Get current date
            const currentDate = new Date().toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric'
            });
    
            // Debug: Log the project object
            console.log('Project object:', JSON.stringify(project, null, 2));
            
            // Get site URL from project or tasks
            const siteUrl = project.site?.url || project.devurl || project.sites?.[0] || project.name || 'Project';
            let siteDisplay = siteUrl;
            let projectName = project.name || 'Project';
            
            // Clean up the site display URL
            try {
                if (siteDisplay) {
                    const url = new URL(siteDisplay.startsWith('http') ? siteDisplay : `https://${siteDisplay}`);
                    siteDisplay = url.hostname.replace(/^\./, '');
                }
            } catch (e) {
                siteDisplay = String(siteDisplay).replace(/^https?:\/\//, '').replace(/^\./, '');
            }

            // Group tasks by page and count severities
            const pageData = {};
            
            // First, process all tasks to extract unique page URLs and names
            tasks.forEach(task => {
                // Get the site URL from project data first, then fall back to task data
                const siteUrl = this.project?.sites?.[0] || this.project?.devurl || task.site || task.task?.site || '';
                let pageUrl = task.page_url || task.task?.page_url || task.url || '';
                
                // Extract URL from description if it exists
                let extractedUrlFromDesc = '';
                if (task.description) {
                    const urlMatch = task.description.match(/URL: (https?:\/\/[^\s\n]+)/i);
                    if (urlMatch && urlMatch[1]) {
                        extractedUrlFromDesc = urlMatch[1];
                    }
                }

                // Normalize URLs for comparison (remove protocol, www, trailing slashes)
                const normalizeUrl = (url) => {
                    if (!url) return '';
                    try {
                        const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
                        let normalized = urlObj.hostname.replace(/^www\./i, '') + 
                                      (urlObj.pathname === '/' ? '' : urlObj.pathname);
                        return normalized.replace(/\/+$/, '');
                    } catch (e) {
                        return url;
                    }
                };

                // Determine the final URL to use
                if (extractedUrlFromDesc) {
                    const normalizedSite = normalizeUrl(siteUrl);
                    const normalizedExtracted = normalizeUrl(extractedUrlFromDesc);
                    
                    if (normalizedSite && normalizedExtracted.startsWith(normalizedSite)) {
                        // If it's the same as site URL, it's the homepage
                        if (normalizedExtracted === normalizedSite) {
                            pageUrl = siteUrl.replace(/\/+$/, '');
                        } else {
                            // Otherwise use the extracted URL
                            pageUrl = extractedUrlFromDesc;
                        }
                    } else if (!pageUrl || pageUrl === '/') {
                        // Only use extracted URL if no pageUrl is set
                        pageUrl = extractedUrlFromDesc;
                    }
                }

                // Handle root path or empty URL
                if ((!pageUrl || pageUrl === '/') && siteUrl) {
                    pageUrl = siteUrl.replace(/\/+$/, '');
                }
                // Handle relative URLs
                else if (pageUrl.startsWith('/') && siteUrl) {
                    pageUrl = siteUrl.replace(/\/+$/, '') + pageUrl;
                }
                
                // Extract page name from URL or use a default
                let pageName = 'Homepage'; // Default page name
                if (pageUrl) {
                    try {
                        const url = new URL(pageUrl.startsWith('http') ? pageUrl : `https://${pageUrl}`);
                        const normalizedSite = siteUrl ? normalizeUrl(siteUrl) : '';
                        const normalizedCurrent = normalizeUrl(pageUrl);
                        
                        // If this is the homepage URL, use 'Homepage' as the page name
                        if (normalizedCurrent === normalizedSite || !url.pathname || url.pathname === '/') {
                            pageName = 'Homepage';
                        } else {
                            // Get all non-empty path segments
                            const segments = url.pathname.split('/').filter(segment => segment.trim() !== '');
                            
                            if (segments.length > 0) {
                                // Use the last segment that's not empty and not a common file extension
                                let lastSegment = '';
                                for (let i = segments.length - 1; i >= 0; i--) {
                                    const segment = segments[i];
                                    // Skip common file extensions and numeric segments
                                    if (!/\.[a-z0-9]{2,5}$/i.test(segment) && !/^\d+$/.test(segment)) {
                                        lastSegment = segment;
                                        break;
                                    }
                                }
                                
                                if (lastSegment) {
                                    pageName = lastSegment
                                        .split('?')[0]  // Remove query string
                                        .split('#')[0]   // Remove hash
                                        .replace(/\.[^/.]+$/, '')  // Remove file extension
                                        .replace(/[-_]+/g, ' ')    // Replace underscores/hyphens with spaces
                                        .replace(/\b\w/g, l => l.toUpperCase())  // Title case
                                        .trim();
                                    
                                    // If we couldn't find a good segment name, use the full path
                                    if (!pageName) {
                                        pageName = segments.join(' > ');
                                    }
                                } else {
                                    // If all segments were filtered out, use the full path
                                    pageName = segments.join(' > ');
                                }
                            }
                        }
                    } catch (e) {
                        console.log('Error processing URL, using default page name for:', pageUrl, e);
                    }
                }
                
                // Initialize page data if not exists
                if (!pageData[pageName]) {
                    pageData[pageName] = {
                        total: 0,
                        critical: 0,
                        important: 0,
                        normal: 0,
                        minor: 0,
                        notSet: 0
                    };
                }
                
                // Map BugHerd priorities to our categories
                const priority = (task.priority || '').toLowerCase();
                const status = (task.status || '').toLowerCase();
                
                // Update counts
                pageData[pageName].total++;
                
                // Map status to priority if priority is not set
                let effectivePriority = priority;
                if (!effectivePriority) {
                    if (status.includes('critical') || status.includes('high')) {
                        effectivePriority = 'critical';
                    } else if (status.includes('important') || status.includes('major')) {
                        effectivePriority = 'important';
                    } else if (status.includes('normal') || status.includes('medium')) {
                        effectivePriority = 'normal';
                    } else if (status.includes('low') || status.includes('minor')) {
                        effectivePriority = 'minor';
                    }
                }
                
                // Categorize based on effective priority
                if (['critical', 'high', 'blocker'].includes(effectivePriority)) {
                    pageData[pageName].critical++;
                } else if (['important', 'major', 'moderate'].includes(effectivePriority)) {
                    pageData[pageName].important++;
                } else if (['normal', 'medium', 'average'].includes(effectivePriority)) {
                    pageData[pageName].normal++;
                } else if (['low', 'minor', 'trivial'].includes(effectivePriority)) {
                    pageData[pageName].minor++;
                } else {
                    pageData[pageName].notSet++;
                }
            });
            
            // Convert to array with page names and sort by total issues (descending)
            const findingsData = Object.entries(pageData).map(([pageName, counts]) => ({
                pageName,
                ...counts
            })).sort((a, b) => b.total - a.total);
            
            // Prepare data for the audit log with all required fields
            const auditLogData = tasks.map(task => ({
                id: task.id,
                page_url: task.page_url || task.task?.page_url || task.url || '',
                pageName: (() => {
                    // Get the page URL from the task and handle relative URLs
                    let pageUrl = task.page_url || task.task?.page_url || task.url || '';
                    const siteUrl = task.site || task.task?.site || '';
                    
                    // If page URL is empty, try to extract it from the description
                    if (!pageUrl && task.description) {
                        const urlMatch = task.description.match(/URL: (https?:\/\/[^\s\n]+)/i);
                        if (urlMatch && urlMatch[1]) {
                            pageUrl = urlMatch[1];
                        }
                    }
                    
                    // Handle root path (/) - use the site URL as base
                    if (pageUrl === '/' && siteUrl) {
                        pageUrl = siteUrl.replace(/\/+$/, '');
                    }
                    // If the URL is relative (starts with /) and we have a site URL, combine them
                    else if (pageUrl.startsWith('/') && siteUrl) {
                        // Remove any trailing slashes from base URL and leading slashes from path
                        pageUrl = siteUrl.replace(/\/+$/, '') + pageUrl;
                    }
                    
                    let pageName = 'Homepage'; // Default page name
                    if (pageUrl) {
                        try {
                            const url = new URL(pageUrl.startsWith('http') ? pageUrl : `https://${pageUrl}`);
                            // Get the full path
                            let path = url.pathname;
                            
                            // Always use the hostname for consistency
                            pageName = url.hostname.replace(/^www\./i, '').split('.')[0];
                            
                            // If it's not the root path, append the last segment
                            if (path !== '/' && path) {
                                const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
                                if (segments.length > 0) {
                                    const lastSegment = segments[segments.length - 1]
                                        .replace(/[-_]/g, ' ')
                                        .replace(/\.(html?|php|aspx?|jsp|cfm|cgi|pl)$/i, '')
                                        .split(' ')
                                        .filter(Boolean)
                                        .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
                                        .join(' ');
                                    if (lastSegment) {
                                        pageName = lastSegment;
                                    }
                                }
                            }
                        } catch (e) {
                            console.log('Using default page name for URL:', pageUrl);
                            return 'Page';
                        }
                    }
                    return pageName;
                })(),
                issueType: task.task_type || 'bug',
                description: task.description || task.text || 'No description',
                priority: (task.priority || 'normal').toLowerCase(),
                status: (task.status || 'new').toLowerCase(),
                screenshot: task.screenshot_url || (task.attachments && task.attachments.length > 0 ? task.attachments[0].url : 'View'),
                created_at: task.created_at || new Date().toISOString(),
                updated_at: task.updated_at || new Date().toISOString(),
                tags: task.tags || [],
                requester_email: task.requester_email || '',
                requester_name: task.requester_name || 'Anonymous',
                assigned_to: task.assigned_to || null
            }));

            // Add debug logging
            console.log('Findings data:', JSON.stringify(findingsData, null, 2));
            console.log('Audit log data:', JSON.stringify(auditLogData, null, 2));
            console.log('Using siteDisplay:', siteDisplay);
            
            // Read the template file
            let templateContent = fs.readFileSync(this.templatePath, 'utf8');
            
            // Create a script tag with the data that will be available immediately
            const dataScript = `
                <script>
                    // Initialize data from server - available immediately
                    window.findingsData = ${JSON.stringify(findingsData)};
                    window.auditLogData = ${JSON.stringify(auditLogData)};
                    console.log('Server-provided findingsData:', window.findingsData);
                    console.log('Server-provided auditLogData:', window.auditLogData);
                </script>`;
                
            // Add initialization script that runs after DOM is loaded
            const initScript = `
                <script>
                    document.addEventListener('DOMContentLoaded', function() {
                        console.log('DOM fully loaded, initializing report...');
                        
                        // Initialize the report
                        if (typeof initializeReport === 'function') {
                            initializeReport();
                        }
                        
                        // Generate tables
                        if (typeof generateTables === 'function') {
                            generateTables();
                        }
                        
                        // Generate audit log tables
                        if (typeof generateAuditLogTables === 'function') {
                            generateAuditLogTables();
                        }
                        
                        // Initialize severity chart
                        if (typeof initSeverityChart === 'function') {
                            initSeverityChart();
                        }
                    });
                </script>
            `;
            
            // Insert the data script in the head section to ensure it's available early
            templateContent = templateContent.replace('</head>', `
                ${dataScript}
            </head>`);
            
            // Insert the initialization script before the closing body tag
            templateContent = templateContent.replace('</body>', `
                ${initScript}
            </body>`);
            
            // Define replacements for other template variables
            const replacements = {
                '{{projectName}}': projectName,
                '{{currentDate}}': currentDate,
                '{{totalIssues}}': tasks.length,
                '{{siteDisplay}}': siteDisplay,
                '{{siteUrl}}': siteUrl ? BrandReportGenerator.ensureProtocol(siteUrl) : '#'
            };
            
            // Apply all replacements
            return Object.entries(replacements).reduce(
                (result, [key, value]) => result.replace(
                    new RegExp(BrandReportGenerator.escapeRegExp(key),), 
                    String(value)
                ),
                templateContent
            );
        } catch (error) {
            console.error('Error rendering HTML:', error);
            throw error;    
        }
    }

    // Helper method to escape special regex characters
    static ensureProtocol(url) {
        if (!url) return url;
        return url.match(/^https?:\/\//) ? url : `https://${url}`;
    }

    // Static method to extract page name from URL with hierarchy
    static getLastSlug(url) {
        if (!url) return 'Home';
        try {
            // Handle full URLs
            if (url.startsWith('http')) {
                const parsed = new URL(url);
                const path = parsed.pathname;
                
                // If it's a root path, return the domain name
                if (path === '/' || !path) {
                    return parsed.hostname.replace(/^www\./, '').split('.')[0] || 'Home';
                }
                
                // Get the last non-empty segment of the path
                const segments = path.split('/').filter(Boolean);
                if (segments.length > 0) {
                    // Return the last segment, or the domain if it's empty
                    return segments[segments.length - 1] || 
                           parsed.hostname.replace(/^www\./, '').split('.')[0] || 'Home';
                }
                return parsed.hostname.replace(/^www\./, '').split('.')[0] || 'Home';
            } 
            // Handle relative URLs
            else {
                const path = url.split('?')[0].split('#')[0];
                const segments = path.split('/').filter(Boolean);
                return segments[segments.length - 1] || 'Home';
            }
        } catch (e) {
            console.error('Error extracting slug from URL:', url, e);
            return 'Home';
        }
    }

    static escapeRegExp(string) {
        return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
}

// Export the class for use in other files
module.exports = BrandReportGenerator;
