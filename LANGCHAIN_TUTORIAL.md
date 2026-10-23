这份教程围绕当前火灾定位项目展开。配套代码在 `learning/`，均已用 Anaconda `agent` 环境运行验证。默认使用离线教学替身；命令加 `--live` 才调用真实 API。离线替身能展示输入输出和控制流程，无法评价真实语义提取效果。

验证记录：九个 demo 的默认离线运行全部成功；02 最小提示词/模型调用和 03 一次提取十条的真实 DeepSeek 运行成功；08 的“删除 clean 并添加 summary”变体也成功。默认 demo 的输出及两次真实调用的输出保存在 `runtime/learning/checks/`。

1. **先把第一个 demo 跑起来**

在 PowerShell 中执行：

```powershell
Set-Location E:\python_proj_record\fire
conda activate agent
python -m learning.demo01_runnable
```

如果 `conda activate` 不可用，直接使用已有环境的解释器：

```powershell
& D:\Anaconda\envs\agent\python.exe -X utf8 -m learning.demo01_runnable
```

后续所有命令都在项目根目录执行。用 `python -m learning.xxx` 是让 Python 按包运行模块，从而正确处理 `from .common import ...` 这种相对导入。直接双击文件或运行 `python learning/demo02_prompt_model.py` 可能出现相对导入错误。

第一个 demo 的核心只有这些：

```python
from langchain_core.runnables import RunnableLambda

def clean(text: str) -> str:
    return text.strip()

def describe(text: str) -> dict:
    return {"text": text, "length": len(text)}

clean_node = RunnableLambda(clean)
describe_node = RunnableLambda(describe)
chain = clean_node | describe_node

result = chain.invoke("  检修车间南边有浓烟  ")
print(result)
```

输出：

```python
{"text": "检修车间南边有浓烟", "length": 9}
```

`RunnableLambda(clean)` 把普通函数包装成有统一调用方式的节点。构造节点不执行函数，`invoke()` 才执行。`|` 把节点串起来：前一个节点的返回值就是后一个节点的输入。

逐步展开，等价于：

```python
middle = clean_node.invoke("  检修车间南边有浓烟  ")
result = describe_node.invoke(middle)
```

这里没有模型调用。清洗、坐标计算、投票等普通 Python 函数都能成为节点。

2. **先认识四个常用词**

| 名称 | 在这个项目中是什么意思 |
| --- | --- |
| Runnable | 有统一执行接口的可运行组件，例如函数包装器、提示词、聊天模型、解析器和组合后的链 |
| LCEL | LangChain 的组合写法，最常见的是 `A \| B \| C` |
| chain | 按一定顺序组合起来的 Runnable |
| node | 教学中对一个处理步骤的称呼；显式的命名节点、边和共享状态由 LangGraph 提供 |

当前项目的主提取链使用 LCEL。`learning/demo08_graph.py` 另外展示 LangGraph，它没有替换现有项目的实现。

不同 Runnable 共用一些调用方法：

| 方法 | 输入与效果 |
| --- | --- |
| `invoke(input)` | 执行一次，返回完整结果；先学这个 |
| `batch([input1, input2])` | 对多个输入分别运行，返回结果列表 |
| `ainvoke(input)` | 异步执行一次，需要 `await` |
| `stream(input)` | 迭代得到输出片段；是否逐字输出取决于节点实现 |
| `with_config(...)` | 为运行附加名称、标签、并发配置等；不会自动把这些值填进提示词 |
| `with_retry(...)` | 包装重试策略；只适合指定的可重试错误 |

尤其要区分：

```python
# 当前项目需要的方式：一个输入中放10条帖子，模型调用一次。
chain.invoke({"posts_json": json.dumps(ten_posts, ensure_ascii=False)})

# 这是10个独立输入；对本项目的ChatOpenAI，通常意味着10次独立模型调用。
chain.batch([{"posts_json": json.dumps([post])} for post in ten_posts])
```

`.batch()` 不会替你把十条帖子拼成一次模型请求。

3. **提示词、模型和字符串解析器**

运行：

```powershell
python -m learning.demo02_prompt_model
python -m learning.demo02_prompt_model --live
```

代码会逐步显示每个组件的输入输出类型。主要结构：

```python
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import StrOutputParser
from learning.common import make_model

prompt = ChatPromptTemplate.from_messages([
    ("system", "请用一句简短中文回答用户的问题。"),
    ("human", "{question}")
])
model = make_model(live=False)  # True 时是接入 DeepSeek 的 ChatOpenAI
parser = StrOutputParser()

chain = prompt | model | parser
answer = chain.invoke({"question": "请向一位 Python 初学者打个招呼。"})
```

数据变化：

```text
dict: {"question": "..."}
  -> ChatPromptValue: system/human 消息
  -> AIMessage: 模型回答对象
  -> str: 回答正文
```

**ChatPromptTemplate 的字段和特性**

| 字段/方法 | 必要性 | 意义和填法 |
| --- | --- | --- |
| `from_messages([...])` | 使用这种构造方式时必要 | 消息列表，每项通常是 `(角色, 模板文本)` |
| `"system"` | 按任务需要 | 固定任务规则，例如每条只能提取一个方向 |
| `"human"` | 本 demo 用到 | 用户输入位置；发送给 API 时相当于 user 消息 |
| `{question}` / `{posts_json}` | 模板有占位符时需要匹配 | 变量名由你决定；`invoke()` 的字典必须有同名键 |
| `input_variables` | 自动推断 | 可以打印它来查实际缺少哪些输入 |
| `partial(name=value)` | 可选 | 预先填好固定变量，后续调用无需再传 |

例如项目提前填输出格式：

```python
prompt = prompt.partial(
    format_instructions=parser.get_format_instructions()
)
```

以后只需传 `posts_json`。`partial()` 产生填好部分变量的新模板，所以要接住返回值。

如果模板文本里要直接写 JSON 示例，其普通花括号需要写成 `{{` 和 `}}`，以免被当成占位符；也可以把 JSON 通过一个变量填入。

**ChatOpenAI 的字段和特性**

真实模型的构造集中在 `learning/common.py`，生产项目在 `fire_locator/providers.py`。项目接入 DeepSeek 时的配置为：

```python
model = ChatOpenAI(
    model=settings.deepseek_model,
    base_url=settings.deepseek_base,
    api_key=key,
    temperature=0,
    max_tokens=3000,
    timeout=120,
    max_retries=2,
    extra_body={"thinking": {"type": "disabled"}},
    model_kwargs={"response_format": {"type": "json_object"}}
)
```

| 字段 | 当前接入是否需要填写 | 意义和本项目填法 |
| --- | --- | --- |
| `model` | 需要 | 供应商认可的模型 ID，当前配置为 `deepseek-flash` |
| `base_url` | 接 DeepSeek 需要 | API 根地址 `https://api.deepseek.com`，不把 `/chat/completions` 写进这里 |
| `api_key` | 需要有来源 | 从 `.env` 读取 `DEEPSEEK_API_KEY`，可以省略显式参数的供应商环境变量机制不用于本项目 |
| `temperature` | 可选 | 生成随机性控制，提取任务设置 0；不是准确率保证 |
| `max_tokens` | 可选 | 单次生成的输出长度上限，不是输入字数；十条结果留足空间 |
| `timeout` | 可选 | 请求等待时间，单位秒 |
| `max_retries` | 可选 | SDK 对适合重试的请求错误的重试次数，不会修复字段错误或缺失结果 |
| `extra_body` | 供应商相关 | 给 API 请求体加入额外字段，本项目关闭 DeepSeek thinking；换供应商要核对支持情况 |
| `model_kwargs` | 可选 | 其他模型请求参数；本项目设置 JSON 输出模式 |

`ChatOpenAI` 是这里使用的兼容接口客户端类名，实际供应商由 `base_url` 和 `model` 决定。

模型节点的输出是 `AIMessage`。回答正文在 `reply.content`，并非直接返回普通字符串。`StrOutputParser()` 把它转换成字符串；这个解析器不需要你提供额外配置字段。

4. **让大模型返回程序能用的对象：一次提取十条**

运行：

```powershell
python -m learning.demo03_batch_parser
python -m learning.demo03_batch_parser --live
```

本课打印十条输入、模型原始 JSON、解析后的对象，并核对返回 ID。

```python
parser = PydanticOutputParser(pydantic_object=BatchExtraction)
prompt = ChatPromptTemplate.from_messages([
    ("system", "逐条提取，每条一个参照物和方向。\n{format_instructions}"),
    ("human", "帖子列表：\n{posts_json}")
]).partial(format_instructions=parser.get_format_instructions())

chain = prompt | model | parser
result = chain.invoke({
    "posts_json": json.dumps(posts, ensure_ascii=False)
})
```

**PydanticOutputParser 的必要配置是 `pydantic_object`**，填一个 Pydantic 模型类，例如 `BatchExtraction`，不是 `BatchExtraction()` 实例。

该模型定义在 `fire_locator/models.py`：

```python
class Extraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    post_id: str
    reference: str | None = None
    direction: Direction = "附近"

class BatchExtraction(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[Extraction]
```

| 定义 | 含义 |
| --- | --- |
| `post_id: str` | 需要这个字段，值应是字符串 |
| `reference: str \| None = None` | 允许名称或空值，未给时采用 None |
| `direction: Direction = "附近"` | 限制到九个方向，缺失时采用附近 |
| `items: list[Extraction]` | 最外层需要 items，里面是独立提取结果的列表 |
| `extra="forbid"` | 禁止出现未定义字段，例如模型额外写一个 explanation |
| `Field(description="...")` | 为字段提供说明，帮助生成格式提示；本身不验证语义是否正确 |

解析后的访问方式：

```python
first = result.items[0]
print(first.post_id)
print(first.reference)
print(first.direction)

# 若想变成普通字典：
data = result.model_dump(mode="json")
```

Pydantic 负责类型和结构。它不自动验证“十条全部返回”“没有重复 ID”“参照物真来自原文”。这些业务要求还要检查。实际项目在 `BatchExtractor.extract()` 校验 ID，并重新按输入顺序排序。

JSON 输出模式也不保证模型一定满足所有字段规则。原始 JSON 合法但方向是“前面”，解析仍会失败。

5. **节点之间如何传信息：返回值、字典和 assign**

运行：

```powershell
python -m learning.demo04_preserve_fields
```

节点通过返回值传递信息。LCEL 不会隐式保留历史输入，也不会自动把一开始的 `location_poi_id` 附在后面的模型结果上。

这个节点：

```python
node = RunnableLambda(lambda data: data["text"].strip())
```

输入是一个包含文本、位置和紧急度的字典，但输出只有字符串，所以后续节点不能从这段字符串读取位置。

要保留多个字段，使用字典，并通过 `RunnablePassthrough.assign()` 加字段：

```python
clean = RunnablePassthrough.assign(
    clean_text=RunnableLambda(lambda data: data["text"].strip())
)
measure = RunnablePassthrough.assign(
    text_length=RunnableLambda(lambda data: len(data["clean_text"]))
)
chain = clean | measure
```

输入：

```python
{"text": "  浓烟  ", "location_poi_id": "B-D-01"}
```

输出：

```python
{
    "text": "  浓烟  ",
    "location_poi_id": "B-D-01",
    "clean_text": "浓烟",
    "text_length": 2
}
```

**assign 的必要条件是输入为字典。** 新字段的名字是你传入的关键字，例如 `clean_text=`。重用已有字段名会覆盖它。同一次 assign 的分支读取相同的原始输入；如果后一个字段依赖前一个新字段，应拆成两个 assign，按顺序连接。

生产项目采用另一种明确传值方式：`_process_batch()` 同时持有原帖子列表和提取结果列表，使用 `zip(posts, extractions)` 按条配对。因此匹配参照物时还能拿到对应帖子的发帖位置。

6. **节点如何添加、删除和替换**

第一个 demo 已经有可运行示例：

```python
chain = clean_node | describe_node

# 添加：在中间插入一个同样 str -> str 的节点。
prefix = RunnableLambda(lambda text: "[帖子]" + text)
chain = clean_node | prefix | describe_node

# 删除：重新组合，去掉 prefix。
chain = clean_node | describe_node
```

LCEL 通常通过重新组合链来增删步骤。修改节点连接后，需要用新链运行。

**添加前先写下新节点的输入和输出类型。** 例如 `prefix: str -> str` 可以插在上述位置。若返回 `dict`，后面的 `describe()` 仍按字符串处理，链就接不上。

在实际提取链后添加“转普通字典”节点：

```python
to_dict = RunnableLambda(lambda result: result.model_dump(mode="json"))
chain = prompt | model | parser | to_dict
```

它接收 `BatchExtraction`，输出字典。此时下游应使用 `result["items"]`，而不是原来的 `result.items`。

删除 parser：

```python
chain = prompt | model
```

输出就变成 `AIMessage`。继续访问 `.items` 会报错，应先处理 `.content`。若改成 `prompt | model | StrOutputParser()`，输出是字符串，也不能直接访问提取对象的字段。

7. **同一输入做多件事，以及按条件选择步骤**

运行：

```powershell
python -m learning.demo05_parallel_branch
```

`RunnableParallel` 把同一个输入交给不同分支，再把结果组装成字典：

```python
parallel = RunnableParallel(
    original=RunnablePassthrough(),
    direction=RunnableLambda(lambda post: "南" if "南边" in post["text"] else "附近"),
    text_length=RunnableLambda(lambda post: len(post["text"]))
)
```

每个分支的输入都是完整的 `post`，输出键分别是 `original`、`direction`、`text_length`。分支之间不要依赖对方的中间结果；有依赖就用顺序连接。

`RunnableBranch` 实现条件路由：

```python
route = RunnableBranch(
    (lambda data: data["direction"] == "附近", circle_node),
    sector_node
)
chain = parallel | route
```

必要构成是“条件函数 + 对应节点”，最后提供默认节点。条件函数返回布尔值，按顺序找到第一个满足条件的分支；未命中时执行默认节点。只执行选中的处理分支。

本项目“附近画圆，其余方向画扇形”就属于这种路由逻辑。当前生产代码用普通 Python 判断实现，教学 demo 用 RunnableBranch 表示同样的控制关系。

8. **编码器、Document、VectorStore 和 Retriever**

运行：

```powershell
python -m learning.demo06_embeddings_store
python -m learning.demo06_embeddings_store --live
```

**Embeddings** 把文本变成数值向量。这里它不是直接使用 `.invoke()` 的普通链节点，而是提供专门方法：

```python
embeddings.embed_query("检修车间")
# 一个向量：list[float]

embeddings.embed_documents(["检修车间", "华安能源综合楼"])
# 两个向量：list[list[float]]
```

需要放进 LCEL 时，可以包装为 `RunnableLambda(embeddings.embed_query)`。

项目自定义编码器 `SiliconFlowEmbeddings(settings, cache_path)` 所需配置：

| 配置 | 意义和填法 |
| --- | --- |
| `settings.embedding_model` | 编码模型 ID：`Qwen/Qwen3-VL-Embedding-8B` |
| `settings.embedding_base` | `https://api.siliconflow.cn/v1`，适配器自己追加 `/embeddings` |
| `SILICONFLOW_API_KEY` | `.env` 中编码服务的 key |
| `cache_path` | 本地缓存文件的 Path，例如 `ROOT / "runtime" / "embedding_cache.json"` |

`SiliconFlowEmbeddings` 继承 LangChain 的 `Embeddings`，实现 `embed_query()` 和 `embed_documents()`，所以 LangChain 向量库可以直接使用它。

真实模型返回 4096 维向量；离线教学替身返回 256 维字符哈希向量。不要把不同模型/维度的向量放在同一个库里。项目对编码服务的批次索引问题做了适配，最多八段文本一批，这与大模型一次提取十条帖子的设置独立。

**Document** 把要编码的内容与业务信息分开：

```python
doc = Document(
    page_content="华安能源检修车间",
    metadata={
        "poi_id": "B-D-01",
        "x_m": 10.744,
        "y_m": 14.754
    }
)
```

`page_content` 是本例送去编码的文本；`metadata` 是附带信息，便于检索后找到坐标和 ID。metadata 中的坐标不会自动变成空间筛选条件。

**InMemoryVectorStore** 的必要依赖是编码器：

```python
store = InMemoryVectorStore(embedding=embeddings)
store.add_documents(documents, ids=poi_ids)
matches = store.similarity_search_with_score("检修车间", k=1)
```

| 字段/方法 | 含义 |
| --- | --- |
| `embedding` | 编码器实例，不是模型名称字符串 |
| `documents` | Document 列表，加入时自动编码 page_content |
| `ids` | 可选的稳定记录 ID 列表，本项目使用 POI ID |
| `k` | 返回最相似的前 k 条，不是相似度阈值 |
| `similarity_search_with_score()` | 返回 `(Document, 分数)` 列表 |
| `similarity_search_with_score_by_vector()` | 已有向量时直接查询，避免再次编码查询文本 |

`InMemoryVectorStore` 是内存库，进程结束后库本身不保留。项目持久化的是编码缓存，启动时再重建向量库。

**Retriever** 是向量库提供的 Runnable 查询接口：

```python
retriever = store.as_retriever(search_kwargs={"k": 1})
documents = retriever.invoke("检修车间")
```

输入查询字符串，输出 `list[Document]`，通常不附相似度分数。需要按 `> 0.7` 判断时，像本项目一样使用带分数的查询方法。

9. **Memory 如何参与当前项目**

当前的 `LocalizationMemory` 是自定义 Python 状态类，并非 LangChain 自带的聊天 Memory，也不是 LangGraph 的 checkpointer。

```python
memory = LocalizationMemory(path, signature, resume=True)
cluster = memory.add_evidence(
    candidates, vector, timestamp, cold_minutes=60
)
memory.save()
```

必要数据：

| 数据 | 意义 |
| --- | --- |
| `path` | 状态保存路径，传 None 时只存在内存中 |
| `signature` | 地图/模型/规则的配置指纹，恢复时防止混用不同状态 |
| `resume` | 是否从已有文件恢复 |
| `candidates` | 当前帖子的候选罐 ID 列表 |
| `vector` | 当前帖子全文的编码向量 |
| `timestamp` | 当前帖子时间，用于簇冷却 |
| `cold_minutes` | 超过多久不加入新帖就不参与当前预测 |

它维护 pending 队列、去重记录、簇、票数和向量统计量。节点间传值与跨批次保存状态是两件事：`A | B` 只解决本次运行的输入输出连接；跨批次要明确读取和更新 Memory。

项目把整批处理函数包装为：

```python
batch_runnable = RunnableLambda(self._process_batch)
update = batch_runnable.invoke(ten_posts)
```

输出是本批明细和预测结果。聚类、几何算法、排名仍由普通 Python 执行。

10. **错误怎么定位：先确定哪一层出了问题**

运行：

```powershell
python -m learning.demo07_debug
```

本课有意制造三种错误，然后修复；最后演示调试节点和定向重试。

| 错误表现 | 通常原因 | 修改方式 |
| --- | --- | --- |
| `ModuleNotFoundError` | 使用了其他 Python 环境或依赖未安装 | 查 `python -c "import sys; print(sys.executable)"`，切到 agent；用同一个解释器运行 `-m pip` |
| attempted relative import | 直接运行了包里的单个脚本 | 在项目根目录使用 `python -m learning.demoXX` |
| prompt 报 missing variables / `KeyError` | 模板要求 text，但输入传了 question | 打印 `prompt.input_variables`，统一字典键名 |
| dict 没有 `.strip()` | 节点期待字符串，收到字典 | 添加读取 `data["text"]` 的节点，或让函数直接处理字典 |
| 下游收到 None | 自定义节点只 print，没有 return | 调试后 `return value`；业务函数返回下一步所需对象 |
| `AIMessage` 没有 `.items` | 删除解析器后，下游仍按 Pydantic 对象处理 | 接回 parser，或调整下游读取 `.content` |
| `OutputParserException` | 返回非 JSON、字段类型错误、方向不在枚举等 | 保存/观察 `raw.content`，核对格式提示、schema、输出长度；先定位再调整 |
| 模型漏掉帖子 ID | JSON 结构合法但业务约束没满足 | 保留 ID 校验，明确提示逐条返回；不要静默拿不完整结果更新状态 |
| HTTP 401 | key 错误或供应商不匹配 | 检查变量名和 base_url，DeepSeek key 与编码 key 分别使用 |
| HTTP 404 / model not found | 根地址、模型 ID 或端点错误 | 检查供应商配置；ChatOpenAI 填根地址，编码适配器根地址含 /v1 |
| HTTP 429 / 超时 | 限流或临时网络问题 | 降低并发，延长合理的 timeout，对临时错误重试 |
| 返回了匹配结果却回退 | 本项目最高余弦未严格超过 0.7 | 看 `match_similarity` 和回退原因，这是业务分支，不一定是异常 |
| Memory 配置不一致 | 改了地图、模型或搜索规则又复用旧状态 | 用新状态目录，勿混用不同向量或规则 |

最容易掌握的调试方法是把链拆开：

```python
messages = prompt.invoke(inputs)
print(type(messages))

raw = model.invoke(messages)
print(type(raw), raw.content)

result = parser.invoke(raw)
print(type(result), result.model_dump())
```

这样只调用一次模型，就能判断是提示词填充、网络调用还是解析失败。对真实业务内容注意控制日志，不输出 API key。

也可以插入一个会原样返回数据的观察节点：

```python
def inspect_value(value):
    print(type(value), value)
    return value

debug = RunnableLambda(inspect_value)
chain = prompt | model | debug | parser
```

重试只修复临时失败，不能修复错误字段：

```python
retry_node = node.with_retry(
    retry_if_exception_type=(TimeoutError,),
    stop_after_attempt=2
)
```

这个例子仅覆盖 TimeoutError，实际 SDK 的异常类型要依据 traceback 指定。ChatOpenAI 自己也有重试设置，叠加包装会增加总尝试次数。不要直接给“整个聚类更新流程”无条件重试，可能重复投票；当前项目先完成外部调用，再整批提交状态，失败时保留 pending。

11. **显式图编排：LangGraph 的节点、边和 State**

先运行默认图，再试增删：

```powershell
python -m learning.demo08_graph
python -m learning.demo08_graph --add-summary
python -m learning.demo08_graph --skip-clean
python -m learning.demo08_graph --skip-clean --add-summary
```

默认图为：

```text
START -> clean -> extract -> spatial -> END
```

增加 summary 后：

```text
START -> clean -> extract -> spatial -> summary -> END
```

基本结构：

```python
class State(TypedDict, total=False):
    text: str
    location_poi_id: str
    clean_text: str
    extraction: Extraction
    candidate_poi_ids: list[str]

def clean(state: State):
    return {"clean_text": state["text"].strip()}

graph = StateGraph(State)
graph.add_node("clean", clean)
graph.add_node("extract", extract)
graph.add_node("spatial", spatial)
graph.add_edge(START, "clean")
graph.add_edge("clean", "extract")
graph.add_edge("extract", "spatial")
graph.add_edge("spatial", END)
app = graph.compile()
result = app.invoke(initial_state)
```

| 配置 | 必要性和含义 |
| --- | --- |
| `StateGraph(State)` | 提供共享状态结构，声明各节点要读写的字段 |
| `add_node("名字", 函数)` | 注册节点；名字唯一，函数接收 state，并返回要更新的字段字典 |
| `add_edge("A", "B")` | 声明执行关系；所引用节点必须注册 |
| `START` / `END` | 特殊入口/终点，不是需要自行注册的函数 |
| `compile()` | 把图构造成可以 invoke/stream 的可执行对象 |
| `invoke(initial_state)` | 输入第一次执行所需的字段，这里至少有 text 和 location_poi_id |

这个简单图使用字段覆盖规则。例如 clean 返回 `{"clean_text": "..."}`，LangGraph 把它写入 State，已有的 text 和 location_poi_id 仍保留。后续节点读取共享 State。

这与 LCEL 的返回值传递不同：LCEL 中函数只返回 clean_text 字符串，下游就只得到字符串；LangGraph 中节点返回一个字段更新字典，框架更新共享状态。

这里的 TypedDict 是字段结构说明，不会像 Pydantic 一样自动严格验证每个值的类型。复杂图的并行写入、列表累计、循环和持久化要再设计 reducer/checkpointer，本课的顺序图不需要这些配置。

删 clean 节点时，删除它的注册及两条关联边，改为 `START -> extract`，同时确保 extract 能读取原始 text；示例已这样处理。添加 summary 时，注册节点，改为 `spatial -> summary -> END`。修改构图代码后重新 compile，不修改已经运行的编译对象。

观察节点返回的增量：

```python
for update in app.stream(initial_state, stream_mode="updates"):
    print(update)
```

它显示每个节点写回哪些字段，不等于大模型逐字输出。一次 stream 已执行整图，不要随后又 invoke 一遍来查看结果，除非你确实想重跑一次模型。

本课加 `--live` 时只有提取节点使用真实 DeepSeek，地点匹配仍用离线向量；完整两家 API 联调在下一课。

12. **回到完整项目：九条先等待，第十条触发**

运行：

```powershell
python -m learning.demo09_project
python -m learning.demo09_project --live
```

这个 demo 使用完整 `FireLocalizer`，但教学状态单独写在 `runtime/learning/`，保留原先 100 条回放的结果。

```python
engine = FireLocalizer(offline=True, state_path=state_path)
engine.ingest(posts[:9])   # pending=9，模型调用0次
result = engine.ingest(posts[9:])  # 第10条，处理一批，模型调用1次
```

实际项目中各处的对应关系：

| 想改什么 | 文件和位置 |
| --- | --- |
| 提取规则，例如参照物如何选择 | `fire_locator/providers.py` 的 SYSTEM_PROMPT |
| 提示词、模型和解析器连接顺序 | 同文件的 `BatchExtractor.__init__()`，`prompt \| model \| parser` |
| 模型返回的字段和枚举 | `fire_locator/models.py` 的 Extraction、BatchExtraction |
| key、API 地址、模型 ID、默认批次大小 | `.env` 与 `fire_locator/config.py` |
| 每条结果如何与原帖子配对 | `fire_locator/engine.py` 的 `_process_batch()` |
| 名称编码和相似度匹配 | `fire_locator/providers.py` 的 SiliconFlowEmbeddings、PoiMatcher |
| 半径/扇形筛选 | `fire_locator/poi.py` 的 candidates()，规则参数来自 Settings |
| 投票、冷却和向量统计量 | `fire_locator/memory.py` |
| 最终前三名排名和输出字段 | `fire_locator/engine.py` 的 prediction() |

修改输出 schema 时要同时检查提示词和下游使用字段的位置。例如把 direction 改为 bearing，不能只改 Pydantic 类；空间筛选读取 `item.direction` 的代码也要调整。

建议每做一个改动都遵循：写清节点输入/输出 -> 单独 invoke 观察 -> 接入链 -> 用小批帖子运行 -> 检查每条 ID 和输出字段 -> 再跑完整回放。

配套练习顺序：01 普通节点，02 提示词与模型，03 批量解析，04 字段保留，05 分流路由，06 向量检索，07 排错，08 显式图，09 完整项目。

官方参考：[Runnable 接口与 LCEL](https://reference.langchain.com/python/langchain-core/runnables/base/Runnable)、[RunnableParallel](https://reference.langchain.com/python/langchain-core/runnables/base/RunnableParallel)、[LangGraph StateGraph](https://reference.langchain.com/python/langgraph/graph/state/StateGraph)。本教程的字段与示例同时按当前 agent 环境里的已安装版本检查并运行。
