from fastapi import FastAPI
from lokidoki.api.routes import tests

app = FastAPI(title="LokiDoki Core")

# Include the test runner router
app.include_router(tests.router, prefix="/api/v1/tests", tags=["Testing"])

@app.get("/")
async def root():
    return {"message": "LokiDoki Core API is running"}
