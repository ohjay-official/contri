//! A small JSON reader for method arguments.
//!
//! The contract reads its own arguments instead of using serde_json. NEAR charges
//! 1 NEAR of storage per 100 KB of contract code, and serde_json's deserializer
//! (with its error formatting, which pulls in float printing) was the largest
//! single part of the contract. Arguments here are small, flat objects, so a
//! strict recursive-descent reader is enough.

#[allow(dead_code)]
pub enum Json {
    Null,
    Bool(bool),
    /// Numbers are kept as their source text and parsed by the caller.
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    Obj(Vec<(String, Json)>),
}

const MAX_DEPTH: u8 = 8;

/// Parses a complete JSON document. Returns `None` on any syntax error or
/// trailing input.
pub fn parse(input: &[u8]) -> Option<Json> {
    let mut p = Reader { b: input, i: 0 };
    let v = p.value(0)?;
    p.ws();
    (p.i == p.b.len()).then_some(v)
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::Str(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_arr(&self) -> Option<&[Json]> {
        match self {
            Json::Arr(items) => Some(items),
            _ => None,
        }
    }

    /// An unsigned integer written as a JSON number or a JSON string.
    pub fn as_uint<T: core::str::FromStr>(&self) -> Option<T> {
        match self {
            Json::Num(n) | Json::Str(n) => n.parse().ok(),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Json::Null)
    }
}

struct Reader<'a> {
    b: &'a [u8],
    i: usize,
}

impl Reader<'_> {
    fn ws(&mut self) {
        while matches!(self.b.get(self.i), Some(b' ' | b'\n' | b'\r' | b'\t')) {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn next(&mut self) -> Option<u8> {
        let c = self.peek()?;
        self.i += 1;
        Some(c)
    }

    fn literal(&mut self, word: &[u8]) -> Option<()> {
        (self.b.get(self.i..self.i + word.len())? == word).then(|| self.i += word.len())
    }

    fn value(&mut self, depth: u8) -> Option<Json> {
        if depth > MAX_DEPTH {
            return None;
        }
        self.ws();
        match self.peek()? {
            b'{' => {
                self.i += 1;
                let mut fields = Vec::new();
                self.ws();
                if self.peek()? == b'}' {
                    self.i += 1;
                    return Some(Json::Obj(fields));
                }
                loop {
                    self.ws();
                    let key = self.string()?;
                    self.ws();
                    (self.next()? == b':').then_some(())?;
                    let v = self.value(depth + 1)?;
                    fields.push((key, v));
                    self.ws();
                    match self.next()? {
                        b',' => continue,
                        b'}' => return Some(Json::Obj(fields)),
                        _ => return None,
                    }
                }
            }
            b'[' => {
                self.i += 1;
                let mut items = Vec::new();
                self.ws();
                if self.peek()? == b']' {
                    self.i += 1;
                    return Some(Json::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.ws();
                    match self.next()? {
                        b',' => continue,
                        b']' => return Some(Json::Arr(items)),
                        _ => return None,
                    }
                }
            }
            b'"' => Some(Json::Str(self.string()?)),
            b't' => self.literal(b"true").map(|_| Json::Bool(true)),
            b'f' => self.literal(b"false").map(|_| Json::Bool(false)),
            b'n' => self.literal(b"null").map(|_| Json::Null),
            b'-' | b'0'..=b'9' => {
                let start = self.i;
                self.i += 1;
                while matches!(self.peek(), Some(b'0'..=b'9' | b'.' | b'e' | b'E' | b'+' | b'-')) {
                    self.i += 1;
                }
                let text = core::str::from_utf8(&self.b[start..self.i]).ok()?;
                Some(Json::Num(text.to_string()))
            }
            _ => None,
        }
    }

    fn hex4(&mut self) -> Option<u32> {
        let h = core::str::from_utf8(self.b.get(self.i..self.i + 4)?).ok()?;
        self.i += 4;
        u32::from_str_radix(h, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        (self.next()? == b'"').then_some(())?;
        let mut out: Vec<u8> = Vec::new();
        loop {
            match self.next()? {
                b'"' => return String::from_utf8(out).ok(),
                b'\\' => match self.next()? {
                    b'"' => out.push(b'"'),
                    b'\\' => out.push(b'\\'),
                    b'/' => out.push(b'/'),
                    b'b' => out.push(8),
                    b'f' => out.push(12),
                    b'n' => out.push(b'\n'),
                    b'r' => out.push(b'\r'),
                    b't' => out.push(b'\t'),
                    b'u' => {
                        let hi = self.hex4()?;
                        let cp = if (0xD800..0xDC00).contains(&hi) {
                            self.literal(b"\\u")?;
                            let lo = self.hex4()?;
                            if !(0xDC00..0xE000).contains(&lo) {
                                return None;
                            }
                            0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)
                        } else {
                            hi
                        };
                        let ch = char::from_u32(cp)?;
                        let mut buf = [0u8; 4];
                        out.extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
                    }
                    _ => return None,
                },
                c if c < 0x20 => return None,
                c => out.push(c),
            }
        }
    }
}
