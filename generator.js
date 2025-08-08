const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
require('dotenv').config();

class ReportGenerator {
    constructor() {
        this.templatePath = path.join(__dirname, 'sample-font-report-2.html');
        this.outputPath = path.join(__dirname, 'generated-report.html');
        this.apiBaseUrl = 'https://api.bugherd.com/api_v2';
        this.apiKey = process.env.BUGHERD_API_KEY;
        
        if (!this.apiKey) {
            console.error('Error: BUGHERD_API_KEY environment variable is not set');
            process.exit(1);
        }
    }

    async generateReport(projectId) {
        try {
            console.log('Fetching project data...');
            const project = await this.fetchProject(projectId);
            
            console.log('Fetching tasks...');
            const tasks = await this.fetchTasks(projectId);
            
            if (tasks.length === 0) {
                console.warn('Warning: No tasks found for this project. The report will be empty.');
            }
            
            console.log('Generating charts...');
            const charts = await this.generateCharts(tasks);
            
            console.log('Rendering HTML...');
            const html = await this.renderHtml(project, tasks, charts);
            
            console.log('Saving report...');
            await this.saveReport(html);
            
            console.log(`Report generated successfully: ${this.outputPath}`);
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
        const response = await axios.get(`${this.apiBaseUrl}/projects/${projectId}.json`, {
            params: { api_key: this.apiKey }
        });
        return response.data.project;
    }

    async fetchTasks(projectId) {
        let allTasks = [];
        let page = 1;
        let hasMore = true;

        while (hasMore) {
            const response = await axios.get(`${this.apiBaseUrl}/projects/${projectId}/tasks.json`, {
                params: {
                    api_key: this.apiKey,
                    page: page,
                    status: 'all',
                    limit: 100 // Max allowed by API
                }
            });

            allTasks = [...allTasks, ...response.data.tasks];
            hasMore = response.data.tasks.length === 100;
            page++;
        }

        return allTasks;
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

    async renderHtml(project, tasks, charts) {
        // Read the template file
        let html = fs.readFileSync(this.templatePath, 'utf8');
        
        // Replace placeholders with actual data
        html = html.replace('<!-- TITLE_PLACEHOLDER -->', `Bug Report - ${project.name}`);
        
        // Add charts data URLs
        html = html.replace('<!-- SEVERITY_CHART_PLACEHOLDER -->', 
            `data:image/png;base64,${charts.severity}`);
        html = html.replace('<!-- STATUS_CHART_PLACEHOLDER -->', 
            `data:image/png;base64,${charts.status}`);
        
        // Generate tasks HTML
        const tasksHtml = this.generateTasksHtml(tasks);
        html = html.replace('<!-- TASKS_PLACEHOLDER -->', tasksHtml);
        
        // Generate summary stats
        const summary = this.generateSummary(tasks);
        html = this.injectSummary(html, summary);
        
        return html;
    }

    generateTasksHtml(tasks) {
        return tasks.map(task => `
            <div class="issue-card" data-severity="${task.priority?.toLowerCase() || 'minor'}" 
                 data-status="${task.status?.name?.toLowerCase() || 'open'}">
                <div class="issue-header">
                    <span class="issue-id">#${task.id}</span>
                    <span class="issue-priority ${task.priority?.toLowerCase() || 'minor'}">
                        ${task.priority || 'Minor'}
                    </span>
                </div>
                <div class="issue-description">
                    ${task.description || 'No description provided'}
                </div>
                <div class="issue-footer">
                    <span class="issue-status">${task.status?.name || 'Open'}</span>
                    <span class="issue-date">${new Date(task.created_at).toLocaleDateString()}</span>
                </div>
            </div>
        `).join('\n');
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
        html = html.replace('<!-- TOTAL_ISSUES -->', summary.total);
        
        // Update severity counts
        Object.entries(summary.bySeverity).forEach(([severity, count]) => {
            html = html.replace(`<!-- ${severity.toUpperCase()}_COUNT -->`, count);
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
        
        return html.replace('<!-- STATUS_ITEMS -->', statusHtml);
    }

    async saveReport(html) {
        return new Promise((resolve, reject) => {
            fs.writeFile(this.outputPath, html, 'utf8', (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
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
