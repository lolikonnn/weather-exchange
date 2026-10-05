import java.io.BufferedWriter;
import java.io.OutputStreamWriter;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * APK 端解析器离线自检（不需要 adb / 设备 / 模拟器）。
 *
 * 为什么需要它：Android 端在 MainActivity 里自己实现了一套 jsObj()，从中国天气网那种
 * `var dataSK={...};` / `var fc40=[...];` 的页面里抠 JSON —— 这是 JS 侧 js_obj() 的 Java 翻版。
 * 本机既没有 Android 设备也没有模拟器，APK 装不上跑不了；但 jsObj 是纯 static、只吃 String、
 * 不碰任何 Android API 的，所以可以借 android.jar 在桌面 JVM 上用反射直接调它，
 * 再拿同一份真实页面原文和"已经过了 20/20 冒烟测试"的 Python 实现做逐条对拍。
 *
 * 输出统统一写进 UTF-8 文件（不打印中文到 stdout —— Windows 控制台是 GBK，会乱码，
 * 看起来像 bug 其实不是）。
 *
 * 用法（由 tools/test_apk_parser.py 驱动，一般不用手工跑）：
 *   java -cp "<android.jar>;<classesDir>" TjsParseTest <页面原文> <输出文件>
 */
public class TjsParseTest {

    public static void main(String[] args) throws Exception {
        String rawPath = args[0];
        String outPath = args[1];

        Class<?> c = Class.forName("com.tjs.weather.MainActivity");
        Method jsObj      = priv(c, "jsObj", String.class, String.class);
        Method parseQuery = priv(c, "parseQuery", String.class);
        Method isCode     = priv(c, "isCode", String.class);
        Method mime       = priv(c, "mime", String.class);
        Method esc        = priv(c, "esc", String.class);

        StringBuilder o = new StringBuilder();

        // ── 1) 真实页面：整段抠出来落盘，交给 Python 侧 json.loads 后逐条比 ──
        String txt = new String(Files.readAllBytes(Paths.get(rawPath)), StandardCharsets.UTF_8);
        String fc40 = (String) jsObj.invoke(null, txt, "fc40");
        Files.write(Paths.get(outPath + ".fc40"), (fc40 == null ? "NULL" : fc40).getBytes(StandardCharsets.UTF_8));
        o.append("raw_len=").append(txt.length()).append('\n');
        o.append("fc40=").append(fc40 == null ? "NULL" : "OK").append('\n');

        // ── 2) 真实 sk_2d / dingzhi 片段（含中文） ──
        String sk = "var dataSK={\"nameen\":\"beijing\",\"cityname\":\"北京\",\"temp\":\"19.1\","
                  + "\"rain\":\"0\",\"aqi\":\"27\",\"weather\":\"晴\",\"date\":\"10月05日\"};"
                  + "var cityDZ101010100={\"weatherinfo\":{\"city\":\"101010100\",\"temp\":\"23\"}};";
        o.append("dataSK=").append(jsObj.invoke(null, sk, "dataSK")).append('\n');
        o.append("cityDZ101010100=").append(jsObj.invoke(null, sk, "cityDZ101010100")).append('\n');
        o.append("missing=").append(jsObj.invoke(null, sk, "noSuchVar")).append('\n');

        // ── 3) 刁钻样本：字符串里藏闭合括号 / 转义引号 / 数组 / 方括号 ──
        probe(o, jsObj, "x", "var x={\"a\":\"}\",\"b\":{\"c\":1}};");
        probe(o, jsObj, "y", "var y={\"a\":\"say \\\"hi\\\"\"};");
        probe(o, jsObj, "z", "var z = [ {\"d\":\"2026-10-05\"}, {\"d\":\"2026-10-06\"} ];");
        probe(o, jsObj, "w", "var w={\"u\":\"a[b]c\",\"v\":[1,2,{\"k\":\"}]\"}]};");

        // ── 4) 其余纯函数 ──
        o.append("q_code=").append(parseQuery.invoke(null, "code=101280101&ym=202610")).append('\n');
        o.append("q_st=").append(parseQuery.invoke(null, "st=54517_tj&ttl=60")).append('\n');
        o.append("q_flag=").append(parseQuery.invoke(null, "flag")).append('\n');
        o.append("q_zh=").append(parseQuery.invoke(null, "q=%E6%9D%AD%E5%B7%9E")).append('\n');
        o.append("isCode_ok=").append(isCode.invoke(null, "101280101")).append('\n');
        o.append("isCode_short=").append(isCode.invoke(null, "1012801")).append('\n');
        o.append("isCode_alpha=").append(isCode.invoke(null, "10128010A")).append('\n');
        for (String p : new String[]{"js/app.js", "css/app.css", "vendor/echarts.min.js",
                                     "index.html", "data/cities.json", "res/ic_launcher.png", "x.woff2"}) {
            o.append("mime[").append(p).append("]=").append(mime.invoke(null, p)).append('\n');
        }
        o.append("esc=").append(esc.invoke(null, "a\"b\\c\nd\te")).append('\n');

        BufferedWriter w = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(outPath), StandardCharsets.UTF_8));
        w.write(o.toString());
        w.close();
        System.out.println("OK -> " + outPath);
    }

    private static void probe(StringBuilder o, Method jsObj, String name, String src) throws Exception {
        o.append("probe_").append(name).append('=').append(jsObj.invoke(null, src, name)).append('\n');
    }

    private static Method priv(Class<?> c, String name, Class<?>... types) throws Exception {
        Method m = c.getDeclaredMethod(name, types);
        m.setAccessible(true);
        return m;
    }
}
