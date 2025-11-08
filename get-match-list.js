const fs = require('fs');
const https = require('https');

// 获取上海时间
function getShanghaiTime() {
  const now = new Date();
  // 上海时间 = UTC +8
  const shanghaiTime = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  return shanghaiTime.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

async function fetchWithRetry(url, options, maxRetries = 2) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const req = https.get(url, options, (res) => {
          let data = '';
          
          res.on('data', (chunk) => {
            data += chunk;
          });
          
          res.on('end', () => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              resolve({ status: res.statusCode, data });
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`));
            }
          });
        });
        
        req.on('error', reject);
        req.setTimeout(10000, () => {
          req.destroy();
          reject(new Error('Request timeout'));
        });
      });
    } catch (error) {
      console.warn(`请求失败 (尝试 ${attempt}/${maxRetries}):`, error.message);
      if (attempt === maxRetries) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function getMatchNodes(mgdbId) {
  const seenNodes = new Set();
  const nodes = [];
  
  try {
    const response = await fetchWithRetry(`https://www.miguvideo.com/p/live/${mgdbId}`, {
      headers: {
        'referer': 'https://www.miguvideo.com/p/schedule/',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0'
      }
    });
    
    const html = response.data;
    const initialDataMatch = html.match(/window\.__INITIAL_BASIC_DATA__\s*=\s*({[^;]+});/);
    
    if (initialDataMatch) {
      try {
        const initialData = JSON.parse(initialDataMatch[1]);
        const matchData = initialData[mgdbId];
        
        if (matchData && matchData.code === 200 && matchData.body && matchData.body.multiPlayList) {
          
          // 按照原来的顺序处理节点数据：preList → liveList → replayList
          const processNodeList = (nodeList) => {
            if (nodeList) {
              for (const item of nodeList) {
                const nodeKey = `${item.pID}|${item.name}`;
                if (!seenNodes.has(nodeKey)) {
                  seenNodes.add(nodeKey);
                  nodes.push({
                    pID: item.pID,
                    name: item.name
                  });
                }
              }
            }
          };
          
          // 保持原来的处理顺序
          processNodeList(matchData.body.multiPlayList.preList);
          processNodeList(matchData.body.multiPlayList.liveList);
          processNodeList(matchData.body.multiPlayList.replayList);
        }
      } catch (parseError) {
        console.error(`解析 JSON 数据失败 (mgdbId: ${mgdbId}):`, parseError.message);
      }
    }
  } catch (error) {
    console.error(`获取节点数据失败 (mgdbId: ${mgdbId}):`, error.message);
  }
  
  return nodes;
}

async function fetchAndProcessData() {
  try {
    console.log('开始获取赛事数据...');
    
    // 获取主JSON数据
    const jsonResponse = await fetchWithRetry('https://vms-sc.miguvideo.com/vms-match/v6/staticcache/basic/match-list/normal-match-list/0/all/default/1/miguvideo');
    const jsonData = JSON.parse(jsonResponse.data);
    
    console.log('主数据获取成功，开始处理比赛数据...');
    
    const result = [];
    
    const matchList = jsonData.body.matchList;
    const dateKeys = Object.keys(matchList).sort();
    
    // 处理每个日期的比赛
    for (const dateKey of dateKeys) {
      const matches = matchList[dateKey];
      console.log(`处理日期 ${dateKey}，共 ${matches.length} 场比赛`);
      
      for (const match of matches) {
        // 获取节点数据
        console.log(`获取比赛 ${match.mgdbId} 的节点数据...`);
        const nodes = await getMatchNodes(match.mgdbId);
        
        const mergedMatch = {
          mgdbId: match.mgdbId,
          pID: match.pID,
          title: match.title,
          keyword: match.keyword,
          sportItemId: match.sportItemId,
          matchStatus: match.matchStatus,
          matchField: match.matchField || "",
          competitionName: match.competitionName,
          padImg: match.padImg || "",
          competitionLogo: match.competitionLogo || "",
          pkInfoTitle: match.pkInfoTitle,
          modifyTitle: match.modifyTitle,
          presenters: match.presenters ? match.presenters.map(p => p.name).join(" ") : "",
          matchInfo: { time: match.keyword },
          nodes: nodes
        };
        
        result.push(mergedMatch);
        
        // 添加延迟以避免请求过于频繁
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // 生成最终数据
    const finalData = {
      success: true,
      updateTime: getShanghaiTime(),
      data: result
    };
    
    return finalData;
    
  } catch (error) {
    console.error('处理数据时发生错误:', error);
    return {
      success: false,
      error: error.message,
      updateTime: getShanghaiTime(),
      data: []
    };
  }
}

// 主执行函数
async function main() {
  try {
    console.log('🚀 开始执行数据获取任务...');
    
    const data = await fetchAndProcessData();
    
    // 检查数据是否有效
    if (!data.success || !data.data || Object.keys(data.data).length === 0) {
      console.log('❌ 数据获取失败或数据为空，不更新文件');
      return;
    }
    
    // 先保存到临时文件
    const tempFilename = 'sports-data-temp.json';
    fs.writeFileSync(tempFilename, JSON.stringify(data, null, 2));
    
    // 验证临时文件是否有效
    try {
      const tempData = JSON.parse(fs.readFileSync(tempFilename, 'utf8'));
      if (tempData.success && tempData.data && Object.keys(tempData.data).length > 0) {
        // 临时文件有效，替换原文件
        fs.renameSync(tempFilename, 'sports-data-latest.json');
        console.log('✅ 最新数据已保存到: sports-data-latest.json');
        console.log(`📊 共处理 ${Object.keys(data.data).length} 个日期的比赛`);
      } else {
        console.log('❌ 临时文件数据无效，不更新原文件');
        fs.unlinkSync(tempFilename); // 删除临时文件
      }
    } catch (error) {
      console.log('❌ 临时文件验证失败，不更新原文件');
      if (fs.existsSync(tempFilename)) {
        fs.unlinkSync(tempFilename); // 删除临时文件
      }
    }
    
  } catch (error) {
    console.error('❌ 执行失败:', error);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main();
}

module.exports = { fetchAndProcessData, getMatchNodes };
